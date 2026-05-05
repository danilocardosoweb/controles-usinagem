import { useState, useMemo } from 'react'
import useSupabase from '../hooks/useSupabase'
import { FaPrint, FaTimes, FaCheckSquare, FaSquare, FaEdit, FaFileAlt, FaBarcode, FaFileWord } from 'react-icons/fa'
import { buildFormularioIdentificacaoHtml, calcularTurno, resolverNomeKit } from '../utils/formularioIdentificacao'

const ReimpressaoApontamentosModal = ({ isOpen, onClose, itens, apontamentos }) => {
  const [selecionados, setSelecionados] = useState({})
  const [imprimindo, setImprimindo] = useState(false)
  const [contadorImpressao, setContadorImpressao] = useState(0)
  const [totalImprimir, setTotalImprimir] = useState(0)
  const [editandoApontamento, setEditandoApontamento] = useState(null)
  const [formEdicao, setFormEdicao] = useState({})
  const { items: kitsDB } = useSupabase('expedicao_kits')
  const { items: kitComponentesDB } = useSupabase('expedicao_kit_componentes')

  // Mapear itens do romaneio com apontamentos completos
  const itensCompletos = useMemo(() => {
    return (itens || []).map(item => {
      const apontamento = apontamentos?.find(a => 
        a.id === item.apontamento_id || 
        a.rack_acabado === item.rack_ou_pallet ||
        a.rack_ou_pallet === item.rack_ou_pallet
      )
      
      // Mesclar dados do apontamento com dados do item do romaneio
      // priorizando o apontamento original para campos de produção
      const apontamentoCompleto = {
        ...item,
        ...apontamento,
        // Garantir campos específicos do romaneio se não existirem no apontamento
        rack_ou_pallet: apontamento?.rack_ou_pallet || apontamento?.rack_acabado || item.rack_ou_pallet,
        produto: apontamento?.produto || item.produto,
        ferramenta: apontamento?.ferramenta || item.ferramenta,
        comprimento_acabado_mm: apontamento?.comprimento_acabado_mm || item.comprimento_acabado_mm,
        quantidade: apontamento?.quantidade || item.quantidade,
        cliente: apontamento?.cliente || item.cliente,
        pedido_seq: apontamento?.pedido_seq || item.pedido_seq,
        pedido_cliente: apontamento?.pedido_cliente || item.pedido_cliente,
        lote: apontamento?.lote || item.lote,
        lote_externo: apontamento?.lote_externo || item.lote_externo,
        loteExterno: apontamento?.lote_externo || apontamento?.loteExterno || item.lote_externo,
        // Campos de data/turno do apontamento original
        inicio: apontamento?.inicio || apontamento?.data_inicio,
        data_inicio: apontamento?.data_inicio || apontamento?.inicio,
        turno: apontamento?.turno,
        dureza_material: apontamento?.dureza_material,
        // Manter o ID do apontamento para referência
        id: apontamento?.id || item.apontamento_id,
        apontamento_id: item.apontamento_id || apontamento?.id
      }
      
      return {
        ...item,
        apontamentoCompleto
      }
    }).sort((a, b) => {
      const rackA = String(a.rack_ou_pallet || '').toUpperCase()
      const rackB = String(b.rack_ou_pallet || '').toUpperCase()
      return rackA.localeCompare(rackB, 'pt-BR', { numeric: true, sensitivity: 'base' })
    })
  }, [itens, apontamentos])

  const toggleSelecionado = (id) => {
    setSelecionados(prev => ({
      ...prev,
      [id]: !prev[id]
    }))
  }

  const selecionarTodos = () => {
    const todos = {}
    itensCompletos.forEach(item => {
      todos[item.apontamento_id || item.id] = true
    })
    setSelecionados(todos)
  }

  const limparSelecao = () => {
    setSelecionados({})
  }

  const abrirEdicao = (item) => {
    setEditandoApontamento(item)
    setFormEdicao({
      rack_ou_pallet: item.rack_ou_pallet || '',
      produto: item.produto || '',
      ferramenta: item.ferramenta || '',
      comprimento_acabado_mm: item.comprimento_acabado_mm || '',
      quantidade: item.quantidade || '',
      cliente: item.cliente || '',
      pedido_seq: item.pedido_seq || '',
      pedido_cliente: item.pedido_cliente || item.apontamentoCompleto?.pedido_cliente || '',
      lote_externo: item.lote_externo || '',
      lote: item.lote || item.apontamentoCompleto?.lote || ''
    })
  }

  const salvarEdicao = () => {
    // Atualizar o item editado nos dados locais
    const itemAtualizado = {
      ...editandoApontamento,
      ...formEdicao,
      apontamentoCompleto: {
        ...editandoApontamento.apontamentoCompleto,
        ...formEdicao
      }
    }
    
    // Atualizar na lista
    const idx = itensCompletos.findIndex(i => (i.id || i.apontamento_id) === (editandoApontamento.id || editandoApontamento.apontamento_id))
    if (idx >= 0) {
      itensCompletos[idx] = itemAtualizado
    }
    
    setEditandoApontamento(null)
  }

  // Função para gerar e imprimir formulário diretamente
  const imprimirFormulario = (apontamento) => {
    const lote = apontamento.lote || ''
    const loteMP = apontamento.lote_externo || apontamento.loteExterno || ''
    const cliente = apontamento.cliente || ''
    const item = apontamento.produto || ''
    const codigoCliente = apontamento.codigo_cliente || ''
    const medida = apontamento.comprimento_acabado_mm 
      ? `${apontamento.comprimento_acabado_mm} mm` 
      : ''
    const pedidoTecno = apontamento.pedido_seq || ''
    const pedidoCli = apontamento.pedido_cliente || apontamento.pedidoCliente || ''
    const qtde = apontamento.quantidade || ''
    const pallet = apontamento.rack_ou_pallet || apontamento.rack_acabado || ''
    const dureza = apontamento.dureza_material || 'N/A'
    
    // Data e turno
    const dataHoraProducao = apontamento.inicio 
      || apontamento.data_inicio 
      || apontamento.data_inicio_producao 
      || ''
    const dataProducao = dataHoraProducao 
      ? new Date(dataHoraProducao).toLocaleDateString('pt-BR') 
      : ''
    const turno = apontamento.turno || calcularTurno(dataHoraProducao)

    // Gerar HTML do formulário
    const nomeKit = resolverNomeKit(item, kitsDB, kitComponentesDB)
    const html = buildFormularioIdentificacaoHtml({
      lote,
      loteMP,
      cliente,
      item,
      codigoCliente,
      nomeKit,
      medida,
      pedidoTecno,
      pedidoCli,
      qtde,
      pallet,
      dureza,
      dataProducao,
      dataHoraProducao,
      turno
    })

    // Abrir em nova janela para impressão
    const printWindow = window.open('', '_blank', 'width=1100,height=800')
    printWindow.document.write(html)
    printWindow.document.close()
    
    // Aguardar carregamento e imprimir
    setTimeout(() => {
      printWindow.print()
    }, 500)
    
    return true
  }

  const iniciarImpressao = async () => {
    const idsSelecionados = Object.keys(selecionados).filter(id => selecionados[id])
    
    if (idsSelecionados.length === 0) {
      alert('Selecione pelo menos um palete para imprimir')
      return
    }
    
    setImprimindo(true)
    setTotalImprimir(idsSelecionados.length)
    setContadorImpressao(0)
    
    // Imprimir um por um com delay
    for (let i = 0; i < idsSelecionados.length; i++) {
      const id = idsSelecionados[i]
      const item = itensCompletos.find(it => String(it.apontamento_id || it.id) === String(id))
      
      if (item && item.apontamentoCompleto) {
        setContadorImpressao(i + 1)
        imprimirFormulario(item.apontamentoCompleto)
        
        // Delay entre impressões para não sobrecarregar
        if (i < idsSelecionados.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 800))
        }
      }
    }
    
    setImprimindo(false)
    alert(`✅ ${idsSelecionados.length} formulário(s) enviado(s) para impressão!`)
    
    // Limpar seleção após impressão
    setSelecionados({})
  }

  const totalSelecionados = Object.values(selecionados).filter(Boolean).length

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-5xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b">
          <div>
            <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
              <FaFileAlt className="text-blue-600" />
              Reimpressão de Apontamentos
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              Selecione os paletes para reimprimir as folhas de apontamento
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
          >
            <FaTimes className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Conteúdo */}
        <div className="flex-1 overflow-auto p-6">
          {/* Ações em massa */}
          <div className="flex flex-wrap gap-3 mb-4">
            <button
              onClick={selecionarTodos}
              className="px-4 py-2 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded-lg text-sm font-medium flex items-center gap-2"
            >
              <FaCheckSquare /> Selecionar Todos ({itensCompletos.length})
            </button>
            <button
              onClick={limparSelecao}
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-medium flex items-center gap-2"
            >
              <FaSquare /> Limpar Seleção
            </button>
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-sm text-gray-600">
                {totalSelecionados} selecionado(s)
              </span>
            </div>
          </div>

          {/* Tabela de paletes */}
          <div className="overflow-x-auto border rounded-lg">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Selecionar</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Palete</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Produto</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Ferramenta</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Qtd</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Cliente</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Pedido Cliente</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Lote Externo</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {itensCompletos.map((item) => {
                  const id = item.apontamento_id || item.id
                  const isSelecionado = !!selecionados[id]
                  
                  return (
                    <tr key={id} className={`hover:bg-gray-50 ${isSelecionado ? 'bg-blue-50' : ''}`}>
                      <td className="px-3 py-3">
                        <button
                          onClick={() => toggleSelecionado(id)}
                          className="text-blue-600 hover:text-blue-800"
                        >
                          {isSelecionado ? <FaCheckSquare className="w-5 h-5" /> : <FaSquare className="w-5 h-5" />}
                        </button>
                      </td>
                      <td className="px-3 py-3 font-semibold text-gray-800">{item.rack_ou_pallet || '-'}</td>
                      <td className="px-3 py-3 text-sm text-gray-600">{item.produto || '-'}</td>
                      <td className="px-3 py-3 text-sm text-gray-600">{item.ferramenta || '-'}</td>
                      <td className="px-3 py-3 text-sm text-gray-600">{item.quantidade || '-'}</td>
                      <td className="px-3 py-3 text-sm text-gray-600">{item.cliente || '-'}</td>
                      <td className="px-3 py-3 text-sm text-gray-600">{item.pedido_cliente || item.apontamentoCompleto?.pedido_cliente || '-'}</td>
                      <td className="px-3 py-3 text-sm text-gray-600">{item.lote_externo || '-'}</td>
                      <td className="px-3 py-3">
                        <button
                          onClick={() => abrirEdicao(item)}
                          className="p-1.5 text-orange-600 hover:bg-orange-50 rounded"
                          title="Editar antes de imprimir"
                        >
                          <FaEdit className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t bg-gray-50">
          <div className="text-sm text-gray-600">
            {totalSelecionados > 0 ? (
              <span className="font-medium text-blue-600">{totalSelecionados} apontamento(s) selecionado(s)</span>
            ) : (
              <span className="text-gray-500">Nenhum apontamento selecionado</span>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              disabled={imprimindo}
              className="px-4 py-2 text-gray-700 hover:bg-gray-200 rounded-lg disabled:opacity-50"
            >
              {imprimindo ? 'Aguarde...' : 'Cancelar'}
            </button>
            <button
              onClick={iniciarImpressao}
              disabled={totalSelecionados === 0 || imprimindo}
              className={`px-6 py-2 rounded-lg font-medium flex items-center gap-2 ${
                totalSelecionados > 0 && !imprimindo
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              }`}
            >
              <FaFileWord /> 
              {imprimindo ? 'Imprimindo...' : `Imprimir ${totalSelecionados > 0 ? `(${totalSelecionados})` : ''}`}
            </button>
          </div>
        </div>
      </div>

      {/* Modal de Edição */}
      {editandoApontamento && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-lg font-semibold text-gray-800">
                <FaEdit className="inline mr-2 text-orange-500" />
                Editar Apontamento - {editandoApontamento.rack_ou_pallet}
              </h3>
              <button
                onClick={() => setEditandoApontamento(null)}
                className="p-2 hover:bg-gray-100 rounded-full"
              >
                <FaTimes className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            
            <div className="p-4 grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Palete/Rack</label>
                <input
                  type="text"
                  value={formEdicao.rack_ou_pallet}
                  onChange={(e) => setFormEdicao({...formEdicao, rack_ou_pallet: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Produto</label>
                <input
                  type="text"
                  value={formEdicao.produto}
                  onChange={(e) => setFormEdicao({...formEdicao, produto: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Ferramenta</label>
                <input
                  type="text"
                  value={formEdicao.ferramenta}
                  onChange={(e) => setFormEdicao({...formEdicao, ferramenta: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Comprimento (mm)</label>
                <input
                  type="text"
                  value={formEdicao.comprimento_acabado_mm}
                  onChange={(e) => setFormEdicao({...formEdicao, comprimento_acabado_mm: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Quantidade</label>
                <input
                  type="number"
                  value={formEdicao.quantidade}
                  onChange={(e) => setFormEdicao({...formEdicao, quantidade: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Cliente</label>
                <input
                  type="text"
                  value={formEdicao.cliente}
                  onChange={(e) => setFormEdicao({...formEdicao, cliente: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Pedido Seq</label>
                <input
                  type="text"
                  value={formEdicao.pedido_seq}
                  onChange={(e) => setFormEdicao({...formEdicao, pedido_seq: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Pedido Cliente</label>
                <input
                  type="text"
                  value={formEdicao.pedido_cliente}
                  onChange={(e) => setFormEdicao({...formEdicao, pedido_cliente: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Lote Externo</label>
                <input
                  type="text"
                  value={formEdicao.lote_externo}
                  onChange={(e) => setFormEdicao({...formEdicao, lote_externo: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Lote</label>
                <input
                  type="text"
                  value={formEdicao.lote}
                  onChange={(e) => setFormEdicao({...formEdicao, lote: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
            </div>
            
            <div className="flex justify-end gap-3 p-4 border-t bg-gray-50">
              <button
                onClick={() => setEditandoApontamento(null)}
                className="px-4 py-2 text-gray-700 hover:bg-gray-200 rounded-lg"
              >
                Cancelar
              </button>
              <button
                onClick={salvarEdicao}
                className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg"
              >
                Salvar Alterações
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Overlay de Impressão em Andamento */}
      {imprimindo && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-8 text-center max-w-md">
            <FaPrint className="w-12 h-12 text-blue-600 mx-auto mb-4 animate-pulse" />
            <h3 className="text-lg font-semibold text-gray-800 mb-2">Imprimindo Formulários...</h3>
            <p className="text-gray-600 mb-4">
              {contadorImpressao} de {totalImprimir} formulários
            </p>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div 
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${(contadorImpressao / totalImprimir) * 100}%` }}
              ></div>
            </div>
            <p className="text-sm text-gray-500 mt-4">
              Aguarde, as janelas de impressão estão sendo abertas
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

export default ReimpressaoApontamentosModal
