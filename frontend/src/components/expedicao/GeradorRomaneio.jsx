import React, { useState, useMemo } from 'react'
import { FaBox, FaTruck, FaCheckCircle, FaExclamationTriangle, FaTimes, FaCalculator } from 'react-icons/fa'
import { calcularKitsCompletos, otimizarCargaPorKits } from '../../utils/kitOptimizer'
import { extrairFerramenta } from '../../utils/expUsinagem'

// Extrair comprimento do código do produto (últimos 4 dígitos antes de letras)
const extrairComprimento = (produto) => {
  if (!produto) return ''
  const s = String(produto).toUpperCase()
  const match = s.match(/(\d{3,4})([A-Z]{2,4})?$/)
  return match ? match[1] : ''
}

/**
 * Componente para gerar romaneios baseado em kits completos
 */
function GeradorRomaneio({ 
  isOpen, 
  onClose, 
  apontamentos = [], 
  kits = [],
  onGerarRomaneio = () => {},
}) {
  const [clienteSelecionado, setClienteSelecionado] = useState('')
  const [kitSelecionado, setKitSelecionado] = useState('')
  const [quantidadeKits, setQuantidadeKits] = useState(1)
  const [simulacao, setSimulacao] = useState(null)
  const [gerando, setGerando] = useState(false)
  const [quantidadesExternas, setQuantidadesExternas] = useState({})

  // Debug: Log kits recebidos
  React.useEffect(() => {
    console.log('🎁 GeradorRomaneio - Kits recebidos:', kits.length)
    console.log('  Kits completos:', kits)
    console.log('  Kits com cliente:', kits.map(k => ({ codigo: k.codigo, cliente: k.cliente })))
    console.log('📍 Apontamentos recebidos:', apontamentos.length)
    console.log('  Clientes nos apontamentos:', [...new Set(apontamentos.map(a => a.cliente))])
  }, [kits, apontamentos])

  // Debug: Log quando modal abre
  React.useEffect(() => {
    if (isOpen) {
      console.log('📂 Modal aberto - Kits disponíveis:', kits.length)
    }
  }, [isOpen, kits])

  // Extrair clientes únicos dos apontamentos
  const clientesUnicos = useMemo(() => {
    const clientes = new Set()
    apontamentos.forEach(apt => {
      if (apt.cliente) clientes.add(apt.cliente)
    })
    return Array.from(clientes).sort()
  }, [apontamentos])

  // Filtrar kits por cliente (case-insensitive)
  const kitsFiltrados = useMemo(() => {
    if (!clienteSelecionado) return kits
    return kits.filter(k => 
      String(k.cliente || '').toUpperCase() === String(clienteSelecionado || '').toUpperCase()
    )
  }, [kits, clienteSelecionado])

  // Agrupar apontamentos por PRODUTO+COMPRIMENTO, FILTRANDO POR CLIENTE
  const paletesDisponiveis = useMemo(() => {
    const agrupado = {}
    
    // Filtrar apontamentos do cliente selecionado (case-insensitive)
    const apontamentosDoCliente = clienteSelecionado 
      ? apontamentos.filter(apt => 
          String(apt.cliente || '').toUpperCase() === String(clienteSelecionado || '').toUpperCase()
        )
      : apontamentos
    
    console.log(`📦 Agrupando ${apontamentosDoCliente.length} apontamentos para ${clienteSelecionado}`)
    if (apontamentosDoCliente.length > 0) {
      console.log(`📦 Exemplo de apontamento:`, apontamentosDoCliente[0])
    }
    
    apontamentosDoCliente.forEach(apt => {
      const produto = String(apt.produto || '').trim().toUpperCase()
      const comprimento = apt.comprimento || extrairComprimento(apt.produto)
      
      // Usar produto completo + comprimento como chave (compatível com componentes do kit)
      const chave = `${produto}|${comprimento}`
      
      if (!agrupado[chave]) {
        agrupado[chave] = {
          ferramenta: extrairFerramenta(apt.produto),
          produto,
          comprimento,
          quantidade: 0,
          racks: [],
        }
      }
      agrupado[chave].quantidade += apt.quantidade
      
      // Extrair nome real do palete — rack_acabado é o campo principal (ex: USI-1246)
      const palete = apt.rack_acabado || apt.rackAcabado || apt.rack_embalagem || apt.rack_ou_pallet || apt.rackOuPallet || 'DESCONHECIDO'
      
      agrupado[chave].racks.push({
        palete: palete,
        quantidade: apt.quantidade,
        apontamentoId: apt.id,
        produtoOriginal: apt.produto,
      })
    })

    const resultado = Object.values(agrupado)
    console.log(`📦 Paletes agrupados: ${resultado.length}`)
    console.log(`📦 Primeiro palete agrupado:`, resultado[0])
    return resultado
  }, [apontamentos, clienteSelecionado])

  // Simular combinação de kits
  const handleSimular = () => {
    if (!kitSelecionado) {
      alert('Selecione um kit para simular')
      return
    }

    const kit = kits.find(k => k.id === kitSelecionado)
    if (!kit) return

    console.log('🎯 Paletes disponíveis antes do cálculo:', paletesDisponiveis)
    console.log('🎯 Primeiro palete:', paletesDisponiveis[0])
    console.log('🎯 Componentes do kit:', kit.componentes)

    const calculo = calcularKitsCompletos(paletesDisponiveis, kit.componentes || [], quantidadesExternas)
    
    console.log('🎯 Resultado do cálculo:', calculo)
    
    setSimulacao({
      kit,
      calculo,
      quantidadeMaxima: calculo.quantidadeKits,
    })
  }

  // Calcular paletes a separar para a quantidade de kits selecionada
  const calcularPaletesParaSeparar = () => {
    if (!simulacao) return []

    const paletesParaSeparar = []

    for (const item of simulacao.calculo.paletesSelecionados) {
      // Calcular quantidade necessária para a quantidade de kits selecionada
      const quantidadeNecessaria = item.quantidadeNecessaria * quantidadeKits
      let quantidadeAcumulada = 0

      console.log(`📦 Calculando separação para ${item.componente} (${item.comprimento}mm)`)
      console.log(`   Quantidade necessária: ${quantidadeNecessaria} un`)
      console.log(`   Paletes disponíveis: ${item.paletes.length}`)

      for (const palete of item.paletes) {
        if (quantidadeAcumulada >= quantidadeNecessaria) break

        const quantidadeDoParlete = Math.min(
          palete.quantidadeDisponivel,
          quantidadeNecessaria - quantidadeAcumulada
        )

        console.log(`   - Rack: ${palete.rack}, Quantidade: ${quantidadeDoParlete}/${palete.quantidadeDisponivel}`)

        paletesParaSeparar.push({
          produto: item.componente,
          ferramenta: palete.ferramenta || item.componente,
          comprimento: item.comprimento,
          produtoOriginal: palete.produto || palete.produtoOriginal,
          quantidadeNecessaria: quantidadeDoParlete,
          rack: palete.rack || 'DESCONHECIDO',
          apontamentoId: palete.apontamentoId,
        })

        quantidadeAcumulada += quantidadeDoParlete
      }

      console.log(`   Total acumulado: ${quantidadeAcumulada}/${quantidadeNecessaria}`)
    }

    return paletesParaSeparar
  }

  // Gerar romaneio
  const handleGerarRomaneio = async () => {
    if (!simulacao) {
      alert('Execute uma simulação primeiro')
      return
    }

    if (quantidadeKits <= 0 || quantidadeKits > simulacao.quantidadeMaxima) {
      alert(`Quantidade de kits inválida. Máximo: ${simulacao.quantidadeMaxima}`)
      return
    }

    setGerando(true)
    try {
      const paletesParaSeparar = calcularPaletesParaSeparar()

      console.log('📦 Paletes para separar (antes de enviar):', paletesParaSeparar)

      const dadosRomaneio = {
        cliente: simulacao.kit.cliente,
        kitId: simulacao.kit.id,
        kitCodigo: simulacao.kit.codigo,
        kitNome: simulacao.kit.nome,
        quantidadeKits: quantidadeKits,
        paletesParaSeparar: paletesParaSeparar,
        resumo: {
          totalPaletes: paletesParaSeparar.length,
          totalUnidades: paletesParaSeparar.reduce((sum, p) => sum + p.quantidadeNecessaria, 0),
          componentes: simulacao.kit.componentes?.length || 0,
        },
      }

      console.log('📋 Dados do Romaneio:', dadosRomaneio)
      console.log('📋 Primeiro palete:', paletesParaSeparar[0])

      await onGerarRomaneio(dadosRomaneio)
      
      // Limpar e fechar
      setClienteSelecionado('')
      setKitSelecionado('')
      setQuantidadeKits(1)
      setSimulacao(null)
      setQuantidadesExternas({})
      onClose()
    } catch (error) {
      console.error('Erro ao gerar romaneio:', error)
      alert('Erro ao gerar romaneio: ' + error.message)
    } finally {
      setGerando(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-gradient-to-r from-blue-600 to-blue-700 px-6 py-4 flex items-center justify-between border-b">
          <div className="flex items-center gap-3">
            <FaTruck className="text-white w-5 h-5" />
            <h2 className="text-xl font-bold text-white">Gerar Romaneio com Kits</h2>
          </div>
          <button
            onClick={onClose}
            className="text-white hover:bg-blue-800 p-2 rounded-lg transition-colors"
          >
            <FaTimes className="w-5 h-5" />
          </button>
        </div>

        {/* Conteúdo */}
        <div className="p-6 space-y-6">
          {/* Seleção de Cliente */}
          <div>
            <label className="block text-sm font-bold text-gray-700 mb-2">
              <FaBox className="inline mr-2 text-blue-600" />
              Cliente
            </label>
            <select
              value={clienteSelecionado}
              onChange={(e) => {
                const novoCliente = e.target.value
                console.log('👤 Cliente selecionado:', novoCliente)
                setClienteSelecionado(novoCliente)
                setKitSelecionado('')
                setSimulacao(null)
                setQuantidadesExternas({})
              }}
              className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
            >
              <option value="">Selecione um cliente</option>
              {clientesUnicos.map(cliente => (
                <option key={cliente} value={cliente}>{cliente}</option>
              ))}
            </select>
          </div>

          {/* Seleção de Kit */}
          {clienteSelecionado && (
            <div>
              <label className="block text-sm font-bold text-gray-700 mb-2">
                <FaBox className="inline mr-2 text-blue-600" />
                Kit ({kitsFiltrados.length} disponível{kitsFiltrados.length !== 1 ? 's' : ''})
              </label>
              {console.log('🎁 Kits filtrados para', clienteSelecionado, ':', kitsFiltrados)}
              <select
                value={kitSelecionado}
                onChange={(e) => {
                  setKitSelecionado(e.target.value)
                  setSimulacao(null)
                  setQuantidadesExternas({})
                }}
                className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
              >
                <option value="">Selecione um kit</option>
                {kitsFiltrados.length > 0 ? (
                  kitsFiltrados.map(kit => (
                    <option key={kit.id} value={kit.id}>
                      {kit.codigo} - {kit.nome} ({kit.componentes?.length || 0} itens)
                    </option>
                  ))
                ) : (
                  <option disabled>Nenhum kit disponível para este cliente</option>
                )}
              </select>
            </div>
          )}

          {/* Paletes Disponíveis */}
          {clienteSelecionado && (
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
              <h3 className="text-sm font-bold text-gray-800 mb-3">
                📦 Paletes Disponíveis para {clienteSelecionado}
              </h3>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {paletesDisponiveis.length > 0 ? (
                  paletesDisponiveis.map((palete, idx) => (
                    <div key={idx} className="flex items-center justify-between bg-white p-2 rounded border border-gray-200 text-xs">
                      <div>
                        <span className="font-bold text-gray-800">{palete.produto}</span>
                        <span className="text-gray-500 ml-2">({palete.comprimento} mm)</span>
                        <span className="text-[10px] text-gray-400 block">{palete.ferramenta} | {palete.racks.length} racks</span>
                      </div>
                      <span className="font-bold text-blue-600">{palete.quantidade} un</span>
                    </div>
                  ))
                ) : (
                  <div className="text-center text-gray-500 text-xs py-4">
                    Nenhum palete disponível para este cliente
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Componentes Externos - campos de quantidade */}
          {kitSelecionado && (() => {
            const kit = kits.find(k => k.id === kitSelecionado)
            const externos = (kit?.componentes || []).filter(c => c.origem === 'externo')
            if (externos.length === 0) return null
            return (
              <div className="bg-orange-50 rounded-lg p-4 border border-orange-200">
                <h3 className="text-sm font-bold text-orange-800 mb-3">
                  📦 Itens Externos (Extrusão de Longos)
                </h3>
                <p className="text-xs text-orange-600 mb-3">Informe a quantidade disponível. Deixe em branco para não limitar.</p>
                <div className="space-y-2">
                  {externos.map((comp, idx) => {
                    const chave = `${String(comp.produto).trim().toUpperCase()}|${String(comp.comprimento || '').trim()}`
                    return (
                      <div key={idx} className="flex items-center gap-3 bg-white p-2 rounded border border-orange-200">
                        <div className="flex-1">
                          <span className="text-xs font-bold text-gray-800">{comp.produto}</span>
                          <span className="text-xs text-gray-500 ml-2">({comp.comprimento} mm)</span>
                          <span className="text-[10px] text-orange-500 ml-2">{comp.quantidade_por_kit} un/kit</span>
                        </div>
                        <input
                          type="number"
                          min="0"
                          placeholder="Qtd disponível"
                          value={quantidadesExternas[chave] || ''}
                          onChange={(e) => setQuantidadesExternas(prev => ({ ...prev, [chave]: e.target.value }))}
                          className="w-32 rounded border border-orange-300 px-2 py-1 text-xs text-right font-bold focus:border-orange-500 focus:outline-none"
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}

          {/* Botão Simular */}
          {kitSelecionado && (
            <button
              onClick={handleSimular}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg flex items-center justify-center gap-2 transition-colors"
            >
              <FaCalculator className="w-4 h-4" />
              Simular Combinação
            </button>
          )}

          {/* Resultado da Simulação */}
          {simulacao && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4 space-y-4">
              <div className="flex items-start gap-3">
                <FaCheckCircle className="text-green-600 w-5 h-5 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <h3 className="font-bold text-green-800 mb-2">Simulação Realizada</h3>
                  <div className="space-y-2 text-sm text-green-700">
                    <p>
                      <span className="font-bold">Kit:</span> {simulacao.kit.codigo} - {simulacao.kit.nome}
                    </p>
                    <p>
                      <span className="font-bold">Quantidade Máxima de Kits:</span> {simulacao.quantidadeMaxima} kits
                    </p>
                    <p>
                      <span className="font-bold">Componentes:</span> {simulacao.kit.componentes?.length || 0} itens
                    </p>
                  </div>
                </div>
              </div>

              {/* Seleção de Quantidade */}
              {simulacao.quantidadeMaxima > 0 && (
                <div className="border-t border-green-200 pt-4">
                  <label className="block text-sm font-bold text-gray-700 mb-2">
                    Quantidade de Kits para Romaneio
                  </label>
                  <input
                    type="number"
                    min="1"
                    max={simulacao.quantidadeMaxima}
                    value={quantidadeKits}
                    onChange={(e) => setQuantidadeKits(Math.min(Number(e.target.value), simulacao.quantidadeMaxima))}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Máximo: {simulacao.quantidadeMaxima} kits
                  </p>
                </div>
              )}

              {/* Detalhes dos Paletes */}
              <div className="border-t border-green-200 pt-4">
                <h4 className="text-sm font-bold text-gray-800 mb-2">Paletes Selecionados</h4>
                <div className="space-y-2 max-h-32 overflow-y-auto">
                  {simulacao.calculo.paletesSelecionados.map((item, idx) => (
                    <div key={idx} className="bg-white p-2 rounded border border-gray-200 text-xs">
                      <div className="flex justify-between items-center">
                        <span className="font-bold">{item.componente} ({item.comprimento})</span>
                        <span className="text-blue-600 font-bold">{item.quantidadeDisponivel} un</span>
                      </div>
                      <div className="text-gray-500 text-[10px] mt-1">
                        <span className="bg-gray-100 px-1 rounded">Usinagem</span> | {item.paletes.length} palete(s) | {item.quantidadeNecessaria} un/kit
                      </div>
                    </div>
                  ))}
                  {(simulacao.calculo.componentesExternos || []).map((item, idx) => (
                    <div key={`ext-${idx}`} className="bg-orange-50 p-2 rounded border border-orange-200 text-xs">
                      <div className="flex justify-between items-center">
                        <span className="font-bold text-orange-800">{item.componente} ({item.comprimento})</span>
                        <span className="text-orange-600 font-bold">{item.quantidadeDisponivel} un</span>
                      </div>
                      <div className="text-orange-500 text-[10px] mt-1">
                        <span className="bg-orange-100 px-1 rounded">Externo</span> | {item.quantidadeNecessaria} un/kit
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Aviso se não conseguir formar kits */}
          {simulacao && simulacao.quantidadeMaxima === 0 && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 flex items-start gap-3">
              <FaExclamationTriangle className="text-yellow-600 w-5 h-5 mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="font-bold text-yellow-800">Aviso</h3>
                <p className="text-sm text-yellow-700 mt-1">
                  Não há paletes suficientes para formar este kit com os apontamentos disponíveis.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-gray-50 px-6 py-4 border-t flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-6 py-2 rounded-lg border border-gray-300 text-gray-700 font-bold hover:bg-gray-100 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleGerarRomaneio}
            disabled={!simulacao || simulacao.quantidadeMaxima === 0 || gerando}
            className="px-6 py-2 rounded-lg bg-green-600 text-white font-bold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {gerando ? 'Gerando...' : 'Gerar Romaneio'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default GeradorRomaneio
