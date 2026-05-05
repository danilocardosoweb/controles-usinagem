import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { FaPlus, FaTrash, FaEdit, FaSave, FaBoxes, FaExclamationTriangle, FaCheckCircle, FaSearch, FaSync, FaWarehouse, FaClipboardList, FaTimes, FaUser, FaWrench, FaRuler, FaTruck, FaEye, FaCube, FaWeight } from 'react-icons/fa'
import useSupabase from '../../hooks/useSupabase'
import supabaseService from '../../services/SupabaseService'
import { extrairFerramenta } from '../../utils/expUsinagem'
import GeradorRomaneio from './GeradorRomaneio'

const createTempId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`
const normalizarTexto = (value) => String(value || '').trim()
const formatQty = (value) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(Number(value) || 0)

const extrairComprimento = (produto) => {
  if (!produto) return ''
  const s = String(produto).toUpperCase()
  const match = s.match(/(\d{3,4})([A-Z]{2,4})?$/)
  return match ? match[1] : ''
}

const initialKitForm = {
  id: null,
  codigo: '',
  nome: '',
  cliente: '',
  produto_pai: '',
  observacoes: '',
  ativo: true,
}

const createInitialComponent = (ordem = 1) => ({
  tempId: createTempId(),
  numero_componente: '',
  produto: '',
  descricao: '',
  comprimento: '',
  quantidade_por_kit: '1',
  unidade: 'UN',
  extrusado: '',
  peso_linear: '',
  ordem,
  origem: 'usinagem',
})

function KitsPanel({ apontamentos = [], romaneios = [], romaneioItens = [], user, loadRomaneios, loadRomaneioItens, loadApontamentos }) {
  const {
    items: kits,
    loading: kitsLoading,
    error: kitsError,
    addItem: addKit,
    updateItem: updateKit,
    removeItem: removeKit,
    loadItems: loadKits,
  } = useSupabase('expedicao_kits')

  // Debug: Log quantidade de apontamentos recebidos
  useEffect(() => {
    console.log('🔍 KitsPanel - Apontamentos recebidos:', apontamentos.length)
    console.log('🔍 KitsPanel - Clientes únicos:', new Set(apontamentos.map(a => a.cliente)).size)
  }, [apontamentos])

  // Debug: Log kits carregados
  useEffect(() => {
    console.log('🎁 KitsPanel - Kits carregados:', kits.length)
    console.log('  Kits:', kits)
    kits.forEach(kit => {
      console.log(`  - ${kit.codigo}: cliente="${kit.cliente}", componentes=${kit.componentes?.length || 0}`)
    })
  }, [kits])

  const {
    items: componentes,
    loading: componentesLoading,
    error: componentesError,
    addItems: addComponentes,
    loadItems: loadComponentes,
    removeItem: removeComponente,
  } = useSupabase('expedicao_kit_componentes')

  const { items: ferramentasCfg } = useSupabase('ferramentas_cfg')

  const [subTab, setSubTab] = useState('expedicao')
  const [search, setSearch] = useState('')
  const [kitForm, setKitForm] = useState(initialKitForm)
  const [filterMode, setFilterMode] = useState('ferramenta')
  const [selectedFerramenta, setSelectedFerramenta] = useState('')
  const [selectedComprimento, setSelectedComprimento] = useState('')
  const [selectedProduto, setSelectedProduto] = useState('')
  const [componentesForm, setComponentesForm] = useState([createInitialComponent(1)])
  const [kitSaving, setKitSaving] = useState(false)
  const [kitMessage, setKitMessage] = useState(null)
  const [selectedKitId, setSelectedKitId] = useState(null)
  const [selectedRackIds, setSelectedRackIds] = useState([])
  const [kitsParaGerar, setKitsParaGerar] = useState(1)
  const [gerandoRomaneio, setGerandoRomaneio] = useState(false)
  const [filtroCliente, setFiltroCliente] = useState('')
  const [filtroFerramenta, setFiltroFerramenta] = useState('')
  const [geradorRomaneioAberto, setGeradorRomaneioAberto] = useState(false)
  const [kitViewModal, setKitViewModal] = useState(null)
  const [paletesModal, setPaletesModal] = useState(null)

  // Pré-preencher cliente quando filtroCliente muda e o formulário de kit está vazio
  useEffect(() => {
    if (filtroCliente && !kitForm.id && !kitForm.cliente) {
      setKitForm(prev => ({ ...prev, cliente: filtroCliente }))
    }
  }, [filtroCliente])

  // Enriquecer kits com seus componentes para o GeradorRomaneio
  const kitsComComponentes = useMemo(() => {
    return kits.map(kit => ({
      ...kit,
      componentes: (Array.isArray(componentes) ? componentes : []).filter((c) => String(c.kit_id) === String(kit.id))
    }))
  }, [kits, componentes])

  // Calcula quantidade expedida por produto
  const quantidadeExpedidaPorProduto = useMemo(() => {
    const expedidas = {}
    ;(Array.isArray(romaneioItens) ? romaneioItens : []).forEach((item) => {
      if (!item.produto) return
      if (!expedidas[item.produto]) expedidas[item.produto] = 0
      expedidas[item.produto] += item.quantidade || 0
    })
    return expedidas
  }, [romaneioItens])

  // Análise de apontamentos para extrair Ferramenta, Comprimento e Produto
  // Os apontamentos já chegam filtrados (rack presente, não expedidos) de Expedicao.jsx
  const analiseApontamentos = useMemo(() => {
    const ferramentasMap = {}
    const produtosMap = {}
    const comprimentosMap = {}
    const combinacoesMap = {}

    // Agrupar quantidades por produto (somando todos os apontamentos do mesmo produto)
    const quantidadePorProduto = {}
    const clientesPorProduto = {}
    const paletesPorCombo = {}

    ;(Array.isArray(apontamentos) ? apontamentos : []).forEach((apt) => {
      if (!apt.produto) return
      const produto = apt.produto
      const qtd = apt.quantidade || 0
      const rack = apt.rack_acabado || apt.rackAcabado || apt.rack_ou_pallet || apt.rackOuPallet || ''

      if (!quantidadePorProduto[produto]) quantidadePorProduto[produto] = 0
      quantidadePorProduto[produto] += qtd

      if (!clientesPorProduto[produto]) clientesPorProduto[produto] = new Set()
      if (apt.cliente) clientesPorProduto[produto].add(apt.cliente)

      // Rastrear paletes por combo ferramenta+comprimento
      const ferramenta = extrairFerramenta(produto)
      const comprimento = extrairComprimento(produto)
      if (ferramenta && comprimento && rack) {
        const chave = `${ferramenta}|${comprimento}`
        if (!paletesPorCombo[chave]) paletesPorCombo[chave] = new Set()
        paletesPorCombo[chave].add(rack)
      }
    })

    // Construir maps a partir das quantidades agregadas
    Object.entries(quantidadePorProduto).forEach(([produto, quantidade]) => {
      const ferramenta = extrairFerramenta(produto)
      const comprimento = extrairComprimento(produto)
      const clientes = clientesPorProduto[produto] || new Set()

      if (ferramenta) {
        if (!ferramentasMap[ferramenta]) {
          ferramentasMap[ferramenta] = { ferramenta, quantidade: 0, produtos: new Set(), comprimentos: new Set() }
        }
        ferramentasMap[ferramenta].quantidade += quantidade
        ferramentasMap[ferramenta].produtos.add(produto)
        if (comprimento) ferramentasMap[ferramenta].comprimentos.add(comprimento)
      }

      if (!produtosMap[produto]) {
        produtosMap[produto] = { produto, quantidade: 0, ferramenta, comprimento, clientes: new Set() }
      }
      produtosMap[produto].quantidade += quantidade
      clientes.forEach(c => produtosMap[produto].clientes.add(c))

      if (comprimento) {
        if (!comprimentosMap[comprimento]) {
          comprimentosMap[comprimento] = { comprimento, quantidade: 0, ferramentas: new Set(), produtos: new Set() }
        }
        comprimentosMap[comprimento].quantidade += quantidade
        if (ferramenta) comprimentosMap[comprimento].ferramentas.add(ferramenta)
        comprimentosMap[comprimento].produtos.add(produto)
      }

      if (ferramenta && comprimento) {
        const chave = `${ferramenta}|${comprimento}`
        if (!combinacoesMap[chave]) {
          combinacoesMap[chave] = { ferramenta, comprimento, quantidade: 0, produtos: new Set(), paletes: paletesPorCombo[chave] || new Set() }
        }
        combinacoesMap[chave].quantidade += quantidade
        combinacoesMap[chave].produtos.add(produto)
      }
    })

    const resultado = {
      ferramentas: Object.values(ferramentasMap).sort((a, b) => b.quantidade - a.quantidade),
      produtos: Object.values(produtosMap).sort((a, b) => b.quantidade - a.quantidade),
      comprimentos: Object.values(comprimentosMap).sort((a, b) => b.quantidade - a.quantidade),
      combinacoes: Object.values(combinacoesMap).sort((a, b) => b.quantidade - a.quantidade),
    }
    
    console.log('📊 Análise de Apontamentos:')
    console.log('  - Ferramentas:', resultado.ferramentas.length)
    console.log('  - Produtos:', resultado.produtos.length)
    console.log('  - Clientes únicos:', new Set(resultado.produtos.flatMap(p => Array.from(p.clientes))).size)
    console.log('  - Combinações F+C:', resultado.combinacoes.length)
    
    return resultado
  }, [apontamentos, quantidadeExpedidaPorProduto])

  const kitsAtivos = useMemo(
    () => (Array.isArray(kits) ? kits : []).filter((kit) => kit?.ativo !== false),
    [kits],
  )

  // Dados filtrados por cliente e ferramenta
  const dadosFiltrados = useMemo(() => {
    let combinacoesFiltradas = analiseApontamentos.combinacoes
    let produtosFiltrados = analiseApontamentos.produtos
    let ferramentasFiltradas = analiseApontamentos.ferramentas

    // Filtro por cliente (aplicar PRIMEIRO)
    if (filtroCliente) {
      const clienteBusca = normalizarTexto(filtroCliente).toUpperCase()
      
      // Filtrar produtos por cliente
      produtosFiltrados = produtosFiltrados.filter((p) =>
        Array.from(p.clientes).some((c) =>
          normalizarTexto(c).toUpperCase().includes(clienteBusca)
        )
      )
      
      // Filtrar combinações por cliente
      const produtosFiltradosSet = new Set(produtosFiltrados.map(p => p.produto))
      combinacoesFiltradas = combinacoesFiltradas.filter((c) =>
        Array.from(c.produtos).some((prod) => produtosFiltradosSet.has(prod))
      )
      
      // Filtrar ferramentas por cliente
      ferramentasFiltradas = ferramentasFiltradas.filter((f) =>
        Array.from(f.produtos).some((prod) => produtosFiltradosSet.has(prod))
      )
    }

    // Filtro por ferramenta (aplicar DEPOIS)
    if (filtroFerramenta) {
      const ferramBusca = normalizarTexto(filtroFerramenta).toUpperCase()
      
      // Filtrar ferramentas
      ferramentasFiltradas = ferramentasFiltradas.filter((f) =>
        normalizarTexto(f.ferramenta).toUpperCase().includes(ferramBusca)
      )
      
      // Filtrar combinações
      combinacoesFiltradas = combinacoesFiltradas.filter((c) =>
        normalizarTexto(c.ferramenta).toUpperCase().includes(ferramBusca)
      )
      
      // Filtrar produtos
      const ferramentasFiltradosSet = new Set(ferramentasFiltradas.map(f => f.ferramenta))
      produtosFiltrados = produtosFiltrados.filter((p) =>
        ferramentasFiltradosSet.has(p.ferramenta)
      )
    }

    return {
      combinacoes: combinacoesFiltradas.filter(c => c.quantidade > 0),
      produtos: produtosFiltrados.filter(p => p.quantidade > 0),
      ferramentas: ferramentasFiltradas,
    }
  }, [analiseApontamentos, filtroCliente, filtroFerramenta])

  // Lista de clientes únicos para dropdown
  // Os apontamentos já chegam filtrados (rack presente, não expedidos) de Expedicao.jsx
  const clientesUnicos = useMemo(() => {
    const clientes = new Set()
    ;(Array.isArray(apontamentos) ? apontamentos : []).forEach((apt) => {
      if (apt.cliente) clientes.add(apt.cliente)
    })
    return Array.from(clientes).sort()
  }, [apontamentos])

  // Lista de ferramentas únicas para dropdown
  // Os apontamentos já chegam filtrados (rack presente, não expedidos) de Expedicao.jsx
  const ferramentasUnicas = useMemo(() => {
    const ferramentas = new Set()
    ;(Array.isArray(apontamentos) ? apontamentos : []).forEach((apt) => {
      if (!apt.produto) return
      const ferramenta = extrairFerramenta(apt.produto)
      if (ferramenta) ferramentas.add(ferramenta)
    })
    return Array.from(ferramentas).sort()
  }, [apontamentos])

  // Mapa: ferramenta|comprimento → lista detalhada de apontamentos (rack, produto, qtd, cliente)
  const apontamentosPorCombo = useMemo(() => {
    const mapa = {}
    ;(Array.isArray(apontamentos) ? apontamentos : []).forEach(apt => {
      if (!apt.produto) return
      const ferramenta = extrairFerramenta(apt.produto)
      const comprimento = extrairComprimento(apt.produto)
      if (!ferramenta || !comprimento) return
      const chave = `${ferramenta}|${comprimento}`
      if (!mapa[chave]) mapa[chave] = []
      mapa[chave].push(apt)
    })
    return mapa
  }, [apontamentos])

  // Mapa: produto (uppercase) → lista detalhada de apontamentos
  const apontamentosPorProduto = useMemo(() => {
    const mapa = {}
    ;(Array.isArray(apontamentos) ? apontamentos : []).forEach(apt => {
      if (!apt.produto) return
      const chave = String(apt.produto).toUpperCase().trim()
      if (!mapa[chave]) mapa[chave] = []
      mapa[chave].push(apt)
    })
    return mapa
  }, [apontamentos])

  // Mapa: produto (uppercase) → array de kits que o utilizam
  const produtoParaKits = useMemo(() => {
    const mapa = {}
    kitsComComponentes.forEach(kit => {
      ;(kit.componentes || []).forEach(comp => {
        if (!comp.produto) return
        const chave = String(comp.produto).toUpperCase().trim()
        if (!mapa[chave]) mapa[chave] = []
        if (!mapa[chave].find(k => k.id === kit.id)) mapa[chave].push(kit)
      })
    })
    return mapa
  }, [kitsComComponentes])

  const refreshAll = useCallback(async () => {
    await loadKits()
    await loadComponentes()
  }, [loadKits, loadComponentes])

  useEffect(() => {
    refreshAll()
  }, [refreshAll])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-gray-200 pb-1">
        <div className="flex gap-6">
          <button
            onClick={() => setSubTab('expedicao')}
            className={`pb-3 text-sm font-bold transition-all ${subTab === 'expedicao' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-400 hover:text-gray-600'}`}
          >
            <span className="flex items-center gap-2">
              <FaClipboardList className="w-4 h-4" /> Análise de Produção
            </span>
          </button>
          <button
            onClick={() => setSubTab('configuracoes')}
            className={`pb-3 text-sm font-bold transition-all ${subTab === 'configuracoes' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-400 hover:text-gray-600'}`}
          >
            <span className="flex items-center gap-2">
              <FaBoxes className="w-4 h-4" /> Configuração de Kits
            </span>
          </button>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={refreshAll}
            className="mb-2 inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <FaSync className={kitsLoading || componentesLoading ? 'animate-spin' : ''} /> Atualizar Dados
          </button>
          <button
            type="button"
            onClick={() => setGeradorRomaneioAberto(true)}
            className="mb-2 inline-flex items-center gap-2 rounded-lg bg-orange-600 hover:bg-orange-700 px-4 py-1.5 text-xs font-bold text-white transition-colors shadow-md"
          >
            <FaTruck className="w-3.5 h-3.5" /> Gerar Romaneio
          </button>
        </div>
      </div>

      {(kitsError || componentesError || kitMessage) && (
        <div className="space-y-2">
          {kitsError && (
            <div className="flex items-center gap-2 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
              <FaExclamationTriangle />
              <span>Tabela de kits ainda não disponível: {kitsError}</span>
            </div>
          )}
          {componentesError && (
            <div className="flex items-center gap-2 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
              <FaExclamationTriangle />
              <span>Componentes de kits: {componentesError}</span>
            </div>
          )}
          {kitMessage && (
            <div className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-sm shadow-sm ${kitMessage.type === 'success' ? 'border-green-200 bg-green-50 text-green-800' : kitMessage.type === 'info' ? 'border-blue-200 bg-blue-50 text-blue-800' : 'border-red-200 bg-red-50 text-red-800'}`}>
              {kitMessage.type === 'success' ? <FaCheckCircle className="text-green-500" /> : <FaExclamationTriangle className={kitMessage.type === 'info' ? 'text-blue-500' : 'text-red-500'} />}
              <span>{kitMessage.text}</span>
              <button onClick={() => setKitMessage(null)} className="ml-auto text-gray-400 hover:text-gray-600">
                <FaTimes className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      )}

      {subTab === 'expedicao' ? (
        <div className="space-y-6">
          {/* Mensagem de Erro/Sucesso no Formulário */}
          {kitMessage && (
            <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 shadow-sm ${kitMessage.type === 'success' ? 'border-green-300 bg-green-50 text-green-800' : kitMessage.type === 'info' ? 'border-blue-300 bg-blue-50 text-blue-800' : 'border-red-300 bg-red-50 text-red-800'}`}>
              {kitMessage.type === 'success' ? <FaCheckCircle className="text-green-600 mt-0.5 flex-shrink-0" /> : <FaExclamationTriangle className={`mt-0.5 flex-shrink-0 ${kitMessage.type === 'info' ? 'text-blue-600' : 'text-red-600'}`} />}
              <div className="flex-1">
                <p className="font-bold text-sm">{kitMessage.type === 'success' ? '✅ Sucesso!' : kitMessage.type === 'info' ? 'ℹ️ Informação' : '⚠️ Erro'}</p>
                <p className="text-sm mt-1">{kitMessage.text}</p>
              </div>
              <button onClick={() => setKitMessage(null)} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
                <FaTimes className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Análise de Produção - Filtros */}
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <h3 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
              <FaWrench className="text-blue-600" /> Análise de Produção
            </h3>
            
            {/* Filtros em linha */}
            <div className="grid gap-4 md:grid-cols-2 mb-6">
              <div>
                <label className="block text-xs font-bold text-gray-600 uppercase mb-2">Ferramenta</label>
                <select
                  value={filtroFerramenta}
                  onChange={(e) => setFiltroFerramenta(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none bg-white hover:border-gray-400 transition-colors"
                >
                  <option value="">Todas ({ferramentasUnicas.length})</option>
                  {ferramentasUnicas.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-600 uppercase mb-2">Cliente</label>
                <select
                  value={filtroCliente}
                  onChange={(e) => setFiltroCliente(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none bg-white hover:border-gray-400 transition-colors"
                >
                  <option value="">Todos ({clientesUnicos.length})</option>
                  {clientesUnicos.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Botão Limpar Filtros */}
            {(filtroFerramenta || filtroCliente) && (
              <div className="flex justify-end mb-4">
                <button
                  onClick={() => {
                    setFiltroFerramenta('')
                    setFiltroCliente('')
                  }}
                  className="text-xs font-bold text-gray-500 hover:text-red-600 flex items-center gap-1 transition-colors"
                >
                  <FaTimes className="w-3 h-3" /> Limpar Filtros
                </button>
              </div>
            )}

            {/* Cards de Resumo */}
            <div className="grid gap-3 md:grid-cols-4">
              <div className="rounded-lg bg-white p-4 border border-blue-100 shadow-sm text-center">
                <p className="text-[10px] font-bold text-gray-400 uppercase">Ferramentas</p>
                <p className="text-2xl font-black text-blue-600 mt-2">{dadosFiltrados.ferramentas.length}</p>
              </div>
              <div className="rounded-lg bg-white p-4 border border-blue-100 shadow-sm text-center">
                <p className="text-[10px] font-bold text-gray-400 uppercase">Produtos</p>
                <p className="text-2xl font-black text-blue-600 mt-2">{dadosFiltrados.produtos.length}</p>
              </div>
              <div className="rounded-lg bg-white p-4 border border-blue-100 shadow-sm text-center">
                <p className="text-[10px] font-bold text-gray-400 uppercase">Comprimentos</p>
                <p className="text-2xl font-black text-blue-600 mt-2">{analiseApontamentos.comprimentos.length}</p>
              </div>
              <div className="rounded-lg bg-white p-4 border border-blue-100 shadow-sm text-center">
                <p className="text-[10px] font-bold text-gray-400 uppercase">Combinações F+C</p>
                <p className="text-2xl font-black text-blue-600 mt-2">{dadosFiltrados.combinacoes.length}</p>
              </div>
            </div>

            {/* Modo de Seleção */}
            <div className="flex gap-3 mt-6 mb-6">
              <button
                onClick={() => setFilterMode('ferramenta')}
                className={`flex-1 py-3 rounded-lg font-bold text-sm transition-all flex items-center justify-center gap-2 ${filterMode === 'ferramenta' ? 'bg-blue-600 text-white shadow-md' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              >
                <FaWrench className="w-4 h-4" /> Por Ferramenta + Comprimento
              </button>
              <button
                onClick={() => setFilterMode('produto')}
                className={`flex-1 py-3 rounded-lg font-bold text-sm transition-all flex items-center justify-center gap-2 ${filterMode === 'produto' ? 'bg-blue-600 text-white shadow-md' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              >
                <FaBoxes className="w-4 h-4" /> Por Produto
              </button>
            </div>

            {/* Visualização por Ferramenta + Comprimento */}
            {filterMode === 'ferramenta' && (
              <div className="space-y-4">
                <h4 className="font-bold text-gray-800 text-sm">Combinações de Ferramenta + Comprimento</h4>
                {dadosFiltrados.combinacoes.length === 0 ? (
                  <div className="p-8 text-center text-gray-400 italic">Nenhuma combinação encontrada com os filtros aplicados.</div>
                ) : (
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                  {dadosFiltrados.combinacoes.map((combo) => (
                    <div key={`${combo.ferramenta}|${combo.comprimento}`} onClick={() => setPaletesModal({ tipo: 'combo', titulo: `${combo.ferramenta} · ${combo.comprimento} mm`, apontamentos: apontamentosPorCombo[`${combo.ferramenta}|${combo.comprimento}`] || [], kitsRelacionados: [...new Map(Array.from(combo.produtos).flatMap(p => produtoParaKits[p.toUpperCase()] || []).map(k => [k.id, k])).values()] })} className="p-4 rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50 transition-all cursor-pointer group">
                      <div className="flex items-start justify-between gap-3 mb-3">
                        <div>
                          <p className="font-bold text-gray-800 text-sm flex items-center gap-2">
                            <FaWrench className="w-3 h-3 text-blue-500" /> {combo.ferramenta}
                          </p>
                          <p className="text-xs text-gray-500 flex items-center gap-2 mt-1">
                            <FaRuler className="w-3 h-3" /> {combo.comprimento} mm
                          </p>
                        </div>
                        <div className="text-right">
                          <span className="text-lg font-black text-blue-600 block">{formatQty(combo.quantidade)}</span>
                          <span className="text-[10px] text-gray-400 font-semibold flex items-center gap-1 justify-end mt-1">
                            <FaBoxes className="w-2.5 h-2.5" /> {combo.paletes?.size || 0} palete{combo.paletes?.size !== 1 ? 's' : ''}
                          </span>
                        </div>
                      </div>
                      <div className="text-[10px] text-gray-500 border-t border-gray-200 pt-2 mt-2">
                        <p className="font-bold mb-1">{combo.produtos.size} Produto(s):</p>
                        <div className="space-y-0.5">
                          {Array.from(combo.produtos).slice(0, 2).map((prod) => (
                            <p key={prod} className="truncate">{prod}</p>
                          ))}
                          {combo.produtos.size > 2 && <p className="text-gray-400">+{combo.produtos.size - 2} mais</p>}
                        </div>
                        {/* Kits que usam algum produto desta combinação */}
                        {(() => {
                          const kitsDoCombo = [...new Map(
                            Array.from(combo.produtos)
                              .flatMap(p => produtoParaKits[p.toUpperCase()] || [])
                              .map(k => [k.id, k])
                          ).values()]
                          if (kitsDoCombo.length === 0) return null
                          return (
                            <div className="mt-2 pt-2 border-t border-gray-100">
                              <p className="font-bold text-[9px] text-gray-400 uppercase mb-1 flex items-center gap-1"><FaCube className="w-2 h-2" /> Kits</p>
                              <div className="flex flex-wrap gap-1">
                                {kitsDoCombo.map(kit => (
                                  <span key={kit.id} onClick={e => { e.stopPropagation(); const compsKit = (Array.isArray(componentes) ? componentes : []).filter(c => String(c.kit_id) === String(kit.id)); setKitViewModal({ kit, comps: compsKit }) }} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-bold text-[9px] cursor-pointer hover:bg-blue-200 transition-colors">
                                    <FaCube className="w-2 h-2" />{kit.codigo} · {kit.nome}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )
                        })()}
                      </div>
                    </div>
                  ))}
                </div>
                )}
              </div>
            )}

            {/* Visualização por Produto */}
            {filterMode === 'produto' && (
              <div className="space-y-4">
                <h4 className="font-bold text-gray-800 text-sm">Produtos Disponíveis</h4>
                {dadosFiltrados.produtos.length === 0 ? (
                  <div className="p-8 text-center text-gray-400 italic">Nenhum produto encontrado com os filtros aplicados.</div>
                ) : (
                <div className="max-h-[500px] overflow-y-auto pr-2">
                  <div className="space-y-2">
                    {dadosFiltrados.produtos.map((prod) => (
                      <div key={prod.produto} onClick={() => setPaletesModal({ tipo: 'produto', titulo: prod.produto, apontamentos: apontamentosPorProduto[prod.produto.toUpperCase()] || [], kitsRelacionados: produtoParaKits[prod.produto.toUpperCase()] || [] })} className="p-4 rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50 transition-all cursor-pointer group">
                        <div className="flex items-center justify-between gap-4">
                          <div className="min-w-0 flex-1">
                            <p className="font-bold text-gray-800 text-sm truncate">{prod.produto}</p>
                            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[10px] text-gray-500">
                              <span className="flex items-center gap-1">
                                <FaWrench className="w-2.5 h-2.5" /> {prod.ferramenta || '-'}
                              </span>
                              <span className="flex items-center gap-1">
                                <FaRuler className="w-2.5 h-2.5" /> {prod.comprimento || '-'} mm
                              </span>
                              <span className="flex items-center gap-1">
                                <FaUser className="w-2.5 h-2.5" /> {Array.from(prod.clientes).join(', ') || '-'}
                              </span>
                            </div>
                          </div>
                          <div className="text-right ml-4 flex-shrink-0">
                            <p className="text-lg font-black text-blue-600">{formatQty(prod.quantidade)}</p>
                            <p className="text-[10px] text-gray-400">peças</p>
                          </div>
                        </div>
                        {/* Kits que usam este produto */}
                        {(() => {
                          const kitsItem = produtoParaKits[prod.produto.toUpperCase()] || []
                          if (kitsItem.length === 0) return (
                            <p className="text-[9px] text-gray-300 mt-2 italic">Não pertence a nenhum kit cadastrado</p>
                          )
                          return (
                            <div className="mt-2 pt-2 border-t border-gray-100 flex flex-wrap gap-1 items-center">
                              <span className="text-[9px] font-bold text-gray-400 uppercase mr-1 flex items-center gap-1"><FaCube className="w-2 h-2" /> Kits:</span>
                              {kitsItem.map(kit => (
                                <span key={kit.id} onClick={e => { e.stopPropagation(); const compsKit = (Array.isArray(componentes) ? componentes : []).filter(c => String(c.kit_id) === String(kit.id)); setKitViewModal({ kit, comps: compsKit }) }} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-bold text-[9px] cursor-pointer hover:bg-blue-600 hover:text-white transition-colors">
                                  <FaCube className="w-2 h-2" />{kit.codigo} · {kit.nome}
                                </span>
                              ))}
                            </div>
                          )
                        })()}
                      </div>
                    ))}
                  </div>
                </div>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_350px]">
          {/* Formulário de Cadastro */}
          <div className="space-y-6">
            <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                    {kitForm.id ? <FaEdit className="text-blue-500" /> : <FaPlus className="text-green-500" />}
                    {kitForm.id ? 'Editar Kit' : 'Novo Kit'}
                  </h3>
                  <p className="text-xs text-gray-500 mt-1">Defina o código, nome e os produtos que compõem este kit.</p>
                </div>
                {kitForm.id && (
                  <button 
                    onClick={() => setKitForm(initialKitForm)}
                    className="text-xs font-bold text-gray-500 hover:text-gray-700 flex items-center gap-1"
                  >
                    <FaTimes /> Novo
                  </button>
                )}
              </div>

              <div className="grid gap-5 md:grid-cols-2 mb-6">
                <label className="block">
                  <span className="text-xs font-bold text-gray-600 uppercase mb-1.5 block">Código do Kit</span>
                  <input
                    type="text"
                    value={kitForm.codigo}
                    onChange={(e) => setKitForm((prev) => ({ ...prev, codigo: e.target.value }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none font-bold"
                    placeholder="Ex: KIT-ESCADA-01"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-bold text-gray-600 uppercase mb-1.5 block">Nome Descritivo</span>
                  <input
                    type="text"
                    value={kitForm.nome}
                    onChange={(e) => setKitForm((prev) => ({ ...prev, nome: e.target.value }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
                    placeholder="Ex: Escada Alumínio 5 Degraus"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-bold text-gray-600 uppercase mb-1.5 block">Cliente</span>
                  <input
                    type="text"
                    value={kitForm.cliente}
                    onChange={(e) => setKitForm((prev) => ({ ...prev, cliente: e.target.value }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
                    placeholder="Ex: Tramontina"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-bold text-gray-600 uppercase mb-1.5 block">Produto Pai (Referência)</span>
                  <input
                    type="text"
                    value={kitForm.produto_pai}
                    onChange={(e) => setKitForm((prev) => ({ ...prev, produto_pai: e.target.value }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
                    placeholder="Ex: TG2012"
                  />
                </label>
              </div>

              <label className="block mb-6">
                <span className="text-xs font-bold text-gray-600 uppercase mb-1.5 block">Observações de Expedição</span>
                <textarea
                  value={kitForm.observacoes}
                  onChange={(e) => setKitForm((prev) => ({ ...prev, observacoes: e.target.value }))}
                  className="min-h-[80px] w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
                  placeholder="Instruções especiais para montagem ou embalagem..."
                />
              </label>

              <div className="flex items-center gap-2 mb-6">
                <input
                  id="kit-ativo"
                  type="checkbox"
                  checked={kitForm.ativo}
                  onChange={(e) => setKitForm((prev) => ({ ...prev, ativo: e.target.checked }))}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <label htmlFor="kit-ativo" className="text-sm font-medium text-gray-700">Kit Ativo (Disponível para expedição)</label>
              </div>

              {/* Componentes */}
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-5">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h4 className="text-sm font-bold text-gray-800 flex items-center gap-2">
                      <FaBoxes className="text-blue-500 w-4 h-4" /> Componentes do Kit
                    </h4>
                    <p className="text-xs text-gray-500 mt-1">Produtos que compõem este kit com suas quantidades</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setComponentesForm([...componentesForm, createInitialComponent(componentesForm.length + 1)])}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-700 shadow-sm"
                  >
                    <FaPlus className="w-2.5 h-2.5" /> Adicionar
                  </button>
                </div>

                <div className="space-y-3">
                  {componentesForm.map((item, idx) => {
                    const upd = (field, val) => {
                      const c = [...componentesForm]
                      c[idx] = { ...item, [field]: val }
                      setComponentesForm(c)
                    }
                    return (
                    <div key={item.tempId} className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm group space-y-2">
                      {/* Linha 1: Nº Comp, Produto, Descrição */}
                      <div className="grid grid-cols-[80px_160px_1fr] items-end gap-2">
                        <label className="space-y-1">
                          <span className="text-[10px] font-bold text-gray-500 uppercase">Nº Comp.</span>
                          <input type="text" value={item.numero_componente || ''}
                            onChange={e => upd('numero_componente', e.target.value)}
                            className="w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-400 focus:outline-none font-mono"
                            placeholder="010000001" />
                        </label>
                        <label className="space-y-1">
                          <span className="text-[10px] font-bold text-gray-500 uppercase">Produto</span>
                          <input type="text" value={item.produto}
                            onChange={e => upd('produto', e.target.value)}
                            className="w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-400 focus:outline-none font-mono"
                            placeholder="Cód. Produto" />
                        </label>
                        <label className="space-y-1">
                          <span className="text-[10px] font-bold text-gray-500 uppercase">Descrição</span>
                          <input type="text" value={item.descricao || ''}
                            onChange={e => upd('descricao', e.target.value)}
                            className="w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-400 focus:outline-none"
                            placeholder="Texto breve do componente" />
                        </label>
                      </div>
                      {/* Linha 2: Comprimento, Qtd, Unidade, Extrusado, Peso Linear, Origem, Excluir */}
                      <div className="grid grid-cols-[90px_60px_70px_70px_90px_90px_32px] items-end gap-2">
                        <label className="space-y-1">
                          <span className="text-[10px] font-bold text-gray-500 uppercase">Comprimento</span>
                          <input type="text" value={item.comprimento}
                            onChange={e => upd('comprimento', e.target.value)}
                            className="w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-400 focus:outline-none"
                            placeholder="Ex: 2081" />
                        </label>
                        <label className="space-y-1">
                          <span className="text-[10px] font-bold text-gray-500 uppercase text-center block">Qtd</span>
                          <input type="number" min="0" step="0.001" value={item.quantidade_por_kit}
                            onChange={e => upd('quantidade_por_kit', e.target.value)}
                            className="w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-400 focus:outline-none text-right font-bold" />
                        </label>
                        <label className="space-y-1">
                          <span className="text-[10px] font-bold text-gray-500 uppercase">Unid.</span>
                          <select value={item.unidade || 'UN'}
                            onChange={e => upd('unidade', e.target.value)}
                            className="w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-400 focus:outline-none">
                            <option>UN</option>
                            <option>M</option>
                            <option>KG</option>
                            <option>PC</option>
                          </select>
                        </label>
                        <label className="space-y-1">
                          <span className="text-[10px] font-bold text-gray-500 uppercase">Extrus.</span>
                          <select value={item.extrusado || ''}
                            onChange={e => upd('extrusado', e.target.value)}
                            className="w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-400 focus:outline-none">
                            <option value="">-</option>
                            <option value="G">G</option>
                            <option value="M">M</option>
                            <option value="C">C</option>
                          </select>
                        </label>
                        <label className="space-y-1">
                          <span className="text-[10px] font-bold text-gray-500 uppercase">Peso Lin.</span>
                          <input type="number" min="0" step="0.0001" value={item.peso_linear || ''}
                            onChange={e => upd('peso_linear', e.target.value)}
                            className="w-full rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-400 focus:outline-none"
                            placeholder="kg/m" />
                        </label>
                        <label className="space-y-1">
                          <span className="text-[10px] font-bold text-gray-500 uppercase">Origem</span>
                          <select value={item.origem || 'usinagem'}
                            onChange={e => upd('origem', e.target.value)}
                            className={`w-full rounded border px-2 py-1.5 text-xs focus:border-blue-400 focus:outline-none font-bold ${
                              (item.origem || 'usinagem') === 'externo' ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-gray-300 text-gray-700'
                            }`}>
                            <option value="usinagem">Usinagem</option>
                            <option value="externo">Externo</option>
                          </select>
                        </label>
                        <button type="button"
                          onClick={() => setComponentesForm(componentesForm.filter((_, i) => i !== idx))}
                          className="inline-flex h-8 w-8 items-center justify-center rounded border border-red-100 bg-red-50 text-red-500 hover:bg-red-500 hover:text-white transition-all opacity-40 group-hover:opacity-100 mt-auto">
                          <FaTrash className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    )
                  })}
                </div>

                {componentesForm.length === 0 && (
                  <div className="p-6 text-center text-gray-400 text-sm italic">
                    Nenhum componente adicionado. Clique em "Adicionar" para começar.
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setComponentesForm([...componentesForm, createInitialComponent(componentesForm.length + 1)])}
                  className="mt-3 w-full inline-flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-blue-300 py-2.5 text-sm font-bold text-blue-500 hover:border-blue-500 hover:bg-blue-50 hover:text-blue-700 transition-all"
                >
                  <FaPlus className="w-3 h-3" /> Adicionar Componente
                </button>
              </div>

              <div className="mt-8 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setKitForm(initialKitForm)
                    setComponentesForm([createInitialComponent(1)])
                    setKitMessage(null)
                  }}
                  disabled={kitSaving}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-6 py-3 text-sm font-bold text-gray-600 hover:bg-gray-50 hover:border-gray-400 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  <FaTimes /> Cancelar
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    console.log('🔘 Botão SALVAR KIT clicado!')
                    setKitSaving(true)
                    try {
                      console.log('📋 Validando formulário...')
                      console.log('  - Código:', kitForm.codigo)
                      console.log('  - Nome:', kitForm.nome)
                      console.log('  - Componentes:', componentesForm.length)
                      
                      if (!kitForm.codigo || !kitForm.nome) {
                        console.log('❌ Erro: Código ou Nome vazio')
                        setKitMessage({ type: 'error', text: 'Código e Nome são obrigatórios.' })
                        setKitSaving(false)
                        return
                      }

                      if (componentesForm.length === 0) {
                        console.log('❌ Erro: Nenhum componente adicionado')
                        setKitMessage({ type: 'error', text: 'Adicione pelo menos um componente.' })
                        setKitSaving(false)
                        return
                      }

                      const kitData = {
                        codigo: normalizarTexto(kitForm.codigo),
                        nome: normalizarTexto(kitForm.nome),
                        cliente: normalizarTexto(kitForm.cliente),
                        produto_pai: normalizarTexto(kitForm.produto_pai),
                        observacoes: normalizarTexto(kitForm.observacoes),
                        ativo: kitForm.ativo,
                        criado_por: user?.nome || 'Sistema',
                      }

                      console.log('🎯 Iniciando salvamento do kit...')
                      let kitId = kitForm.id
                      console.log('📝 Dados do kit para salvar:', kitData)
                      
                      if (kitForm.id) {
                        console.log('🔄 Atualizando kit existente:', kitForm.id)
                        await updateKit({ id: kitForm.id, ...kitData })
                      } else {
                        console.log('✨ Criando novo kit...')
                        try {
                          const novoKitId = await addKit(kitData)
                          console.log('📦 Retorno de addKit:', novoKitId)
                          kitId = novoKitId
                        } catch (err) {
                          console.error('❌ Erro ao adicionar kit:', err)
                          throw err
                        }
                      }

                      if (!kitId) throw new Error('Erro ao salvar kit - ID não retornado')

                      console.log('✅ Kit salvo com ID:', kitId)

                      // Salvar componentes
                      // Se estamos editando, deletar componentes antigos primeiro
                      if (kitForm.id) {
                        console.log('🗑️ Deletando componentes antigos do kit:', kitForm.id)
                        // Buscar componentes antigos
                        const componentesAntigos = componentes.filter((c) => c.kit_id === kitForm.id)
                        console.log('  - Componentes antigos encontrados:', componentesAntigos.length)
                        
                        // Deletar cada componente antigo
                        for (const comp of componentesAntigos) {
                          await removeComponente(comp.id)
                        }
                      }

                      const componentesParaSalvar = componentesForm
                        .filter((c) => c.produto)
                        .map((c) => ({
                          kit_id: kitId,
                          numero_componente: normalizarTexto(c.numero_componente),
                          produto: normalizarTexto(c.produto),
                          descricao: normalizarTexto(c.descricao),
                          comprimento: normalizarTexto(c.comprimento),
                          quantidade_por_kit: Number(c.quantidade_por_kit) || 1,
                          unidade: normalizarTexto(c.unidade) || 'UN',
                          extrusado: normalizarTexto(c.extrusado),
                          peso_linear: c.peso_linear !== '' && c.peso_linear != null ? Number(c.peso_linear) : null,
                          ordem: Number(c.ordem) || 0,
                          origem: c.origem || 'usinagem',
                        }))
                      
                      console.log('📦 Componentes para salvar:', componentesParaSalvar)

                      if (componentesParaSalvar.length > 0) {
                        await addComponentes(componentesParaSalvar)
                      }

                      setKitMessage({ type: 'success', text: `Kit "${kitForm.nome}" salvo com sucesso!` })
                      setKitForm(initialKitForm)
                      setComponentesForm([createInitialComponent(1)])
                      await refreshAll()
                    } catch (error) {
                      console.error('Erro ao salvar kit:', error)
                      setKitMessage({ type: 'error', text: error?.message || 'Erro ao salvar kit.' })
                    } finally {
                      setKitSaving(false)
                    }
                  }}
                  disabled={kitSaving}
                  className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-8 py-3 text-sm font-black text-white hover:bg-green-700 shadow-md hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-50 transition-all"
                >
                  <FaSave /> {kitSaving ? 'SALVANDO...' : 'SALVAR KIT'}
                </button>
              </div>
            </div>
          </div>

          {/* Painel Lateral: Kits Cadastrados */}
          <div className="space-y-6">
            <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm h-fit">
              <h3 className="text-sm font-bold text-gray-800 mb-4 flex items-center gap-2">
                <FaBoxes className="text-gray-400" />
                Kits Cadastrados ({kitsAtivos.length})
              </h3>
              
              <div className="relative mb-4">
                <FaSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-3 h-3" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-lg text-xs focus:border-blue-400 focus:outline-none"
                  placeholder="Buscar kit..."
                />
              </div>

              <div className="space-y-3 max-h-[700px] overflow-y-auto pr-1">
                {kitsAtivos.length === 0 ? (
                  <div className="p-8 text-center text-gray-400 italic text-sm">Nenhum kit cadastrado</div>
                ) : (
                  kitsAtivos.map((kit) => {
                    const comps = (Array.isArray(componentes) ? componentes : []).filter((c) => String(c.kit_id) === String(kit.id))
                    return (
                      <div key={kit.id} onClick={() => { const compsKit = (Array.isArray(componentes) ? componentes : []).filter((c) => String(c.kit_id) === String(kit.id)); setKitViewModal({ kit, comps: compsKit }) }} className="p-4 rounded-xl border border-gray-200 hover:border-blue-200 transition-all group relative overflow-hidden cursor-pointer">
                        <div className={`absolute left-0 top-0 bottom-0 w-1 ${kit.ativo !== false ? 'bg-green-500' : 'bg-gray-300'}`}></div>
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-black text-gray-800 text-sm tracking-tight">{kit.codigo}</span>
                              {kit.ativo === false && <span className="text-[8px] bg-gray-100 text-gray-500 px-1 py-0.5 rounded font-bold uppercase">Inativo</span>}
                            </div>
                            <p className="text-xs font-medium text-gray-500 truncate mt-0.5">{kit.nome}</p>
                            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                              <span className="text-[10px] text-gray-400 flex items-center gap-1 font-bold">
                                <FaUser className="w-2 h-2" /> {kit.cliente || '-'}
                              </span>
                              <span className="text-[10px] text-gray-400 flex items-center gap-1 font-bold">
                                <FaWarehouse className="w-2 h-2" /> {comps.length} Itens
                              </span>
                            </div>
                          </div>
                          <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => {
                                setKitForm(kit)
                                setComponentesForm(
                                  comps.map((c) => ({
                                    tempId: createTempId(),
                                    numero_componente: c.numero_componente || '',
                                    produto: c.produto,
                                    descricao: c.descricao || '',
                                    comprimento: c.comprimento || '',
                                    quantidade_por_kit: String(c.quantidade_por_kit),
                                    unidade: c.unidade || 'UN',
                                    extrusado: c.extrusado || '',
                                    peso_linear: c.peso_linear != null ? String(c.peso_linear) : '',
                                    ordem: c.ordem,
                                    origem: c.origem || 'usinagem',
                                  }))
                                )
                              }}
                              className="p-2 bg-gray-100 text-gray-600 rounded-lg hover:bg-blue-600 hover:text-white transition-all"
                              title="Editar"
                            >
                              <FaEdit className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={async () => {
                                if (window.confirm(`Deseja excluir o kit "${kit.codigo}"?`)) {
                                  try {
                                    await removeKit(kit.id)
                                    setKitMessage({ type: 'success', text: 'Kit excluído com sucesso.' })
                                    await refreshAll()
                                  } catch (error) {
                                    setKitMessage({ type: 'error', text: 'Erro ao excluir kit.' })
                                  }
                                }
                              }}
                              className="p-2 bg-gray-100 text-gray-600 rounded-lg hover:bg-red-600 hover:text-white transition-all"
                              title="Excluir"
                            >
                              <FaTrash className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Paletes por Combo/Produto */}
      {paletesModal && (() => {
        const apts = paletesModal.apontamentos || []
        // Agrupar por rack
        const racksMap = {}
        apts.forEach(apt => {
          const rack = apt.rack_acabado || apt.rackAcabado || apt.rack_ou_pallet || apt.rackOuPallet || 'SEM RACK'
          if (!racksMap[rack]) racksMap[rack] = { rack, total: 0, produtos: {}, cliente: apt.cliente || '' }
          const prod = apt.produto || '-'
          if (!racksMap[rack].produtos[prod]) racksMap[rack].produtos[prod] = 0
          racksMap[rack].produtos[prod] += apt.quantidade || 0
          racksMap[rack].total += apt.quantidade || 0
        })
        const racks = Object.values(racksMap).filter(r => r.total > 0).sort((a,b) => b.total - a.total)
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setPaletesModal(null)}>
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
            <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
              <div className="flex items-start justify-between p-5 border-b border-gray-100">
                <div>
                  <div className="flex items-center gap-2 mb-0.5">
                    <FaWarehouse className="text-blue-600 w-4 h-4" />
                    <span className="font-black text-gray-800 text-base">{paletesModal.titulo}</span>
                  </div>
                  <div className="flex gap-3 mt-1">
                    <span className="text-[10px] text-gray-400 font-bold">{racks.length} racks · {apts.reduce((s, a) => s + (a.quantidade||0), 0).toLocaleString('pt-BR')} peças</span>
                    {paletesModal.kitsRelacionados.length > 0 && (
                      <span className="text-[10px] text-blue-500 font-bold flex items-center gap-1">
                        <FaCube className="w-2.5 h-2.5" /> {paletesModal.kitsRelacionados.map(k => k.codigo).join(', ')}
                      </span>
                    )}
                  </div>
                </div>
                <button onClick={() => setPaletesModal(null)} className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-all"><FaTimes className="w-4 h-4" /></button>
              </div>
              <div className="overflow-y-auto flex-1 p-5">
                {racks.length === 0 ? (
                  <div className="p-8 text-center text-gray-400 italic text-sm">Nenhum rack encontrado</div>
                ) : (
                  <div className="space-y-2">
                    {racks.map((r, i) => (
                      <div key={r.rack} className="flex items-start gap-3 p-3 rounded-lg border border-gray-100 hover:bg-gray-50 transition-colors">
                        <div className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-[10px] font-black flex items-center justify-center">{i+1}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-black text-gray-800 text-sm font-mono">{r.rack}</span>
                            <span className="font-black text-blue-600 text-sm">{r.total.toLocaleString('pt-BR')} pç</span>
                          </div>
                          <div className="mt-1 space-y-0.5">
                            {Object.entries(r.produtos).map(([prod, qtd]) => (
                              <div key={prod} className="flex items-center justify-between text-[10px] text-gray-500">
                                <span className="font-mono truncate">{prod}</span>
                                <span className="font-bold ml-2 flex-shrink-0">{qtd.toLocaleString('pt-BR')}</span>
                              </div>
                            ))}
                          </div>
                          {r.cliente && <p className="text-[9px] text-gray-400 mt-1 flex items-center gap-1"><FaUser className="w-2 h-2"/>{r.cliente}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex justify-between items-center px-5 py-4 border-t border-gray-100 bg-gray-50 rounded-b-2xl">
                <button
                  onClick={() => {
                    const totalPecas = apts.reduce((s, a) => s + (a.quantidade||0), 0)
                    const kitsStr = paletesModal.kitsRelacionados.map(k => `${k.codigo} – ${k.nome}`).join(', ')
                    const linhas = racks.map((r, i) => `
                      <tr>
                        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;color:#555;">${i+1}</td>
                        <td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:700;font-family:monospace;">${r.rack}</td>
                        <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:11px;color:#555;">${Object.keys(r.produtos).join(', ')}</td>
                        <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#555;">${r.cliente}</td>
                        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:700;color:#1d4ed8;">${r.total.toLocaleString('pt-BR')}</td>
                      </tr>`).join('')
                    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Paletes – ${paletesModal.titulo}</title>
                      <style>body{font-family:sans-serif;margin:20px;color:#111}h2{margin:0 0 4px}p{margin:0 0 12px;color:#666;font-size:13px}table{width:100%;border-collapse:collapse}th{background:#f1f5f9;padding:7px 10px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b}@media print{button{display:none}}</style>
                      </head><body>
                      <h2>${paletesModal.titulo}</h2>
                      <p>${racks.length} racks &nbsp;·&nbsp; ${totalPecas.toLocaleString('pt-BR')} peças${kitsStr ? `&nbsp;·&nbsp; Kits: ${kitsStr}` : ''}</p>
                      <table><thead><tr><th>#</th><th>Rack</th><th>Produto(s)</th><th>Cliente</th><th style="text-align:right">Qtd</th></tr></thead>
                      <tbody>${linhas}</tbody></table>
                      <p style="margin-top:16px;font-size:11px;color:#aaa">Impresso em ${new Date().toLocaleString('pt-BR')}</p>
                      <script>window.onload=()=>window.print()</script></body></html>`
                    const w = window.open('', '_blank', 'width=800,height=600')
                    w.document.write(html)
                    w.document.close()
                  }}
                  className="px-4 py-2 rounded-lg bg-gray-700 text-white text-xs font-bold hover:bg-gray-900 transition-all flex items-center gap-1.5"
                >
                  🖨️ Imprimir
                </button>
                <button onClick={() => setPaletesModal(null)} className="px-4 py-2 rounded-lg border border-gray-300 text-xs font-bold text-gray-600 hover:bg-gray-100 transition-all">Fechar</button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Modal Visualização de Estrutura do Kit */}
      {kitViewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setKitViewModal(null)}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-start justify-between p-5 border-b border-gray-100">
              <div>
                <div className="flex items-center gap-2 mb-0.5">
                  <FaCube className="text-blue-600 w-4 h-4" />
                  <span className="font-black text-gray-800 text-lg tracking-tight">{kitViewModal.kit.codigo}</span>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${kitViewModal.kit.ativo !== false ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {kitViewModal.kit.ativo !== false ? 'Ativo' : 'Inativo'}
                  </span>
                </div>
                <p className="text-sm text-gray-500 font-medium">{kitViewModal.kit.nome}</p>
                <div className="flex gap-3 mt-1">
                  {kitViewModal.kit.cliente && <span className="text-[10px] text-gray-400 flex items-center gap-1"><FaUser className="w-2 h-2" />{kitViewModal.kit.cliente}</span>}
                  <span className="text-[10px] text-gray-400 flex items-center gap-1"><FaWarehouse className="w-2 h-2" />{kitViewModal.comps.length} componentes</span>
                </div>
              </div>
              <button onClick={() => setKitViewModal(null)} className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-all">
                <FaTimes className="w-4 h-4" />
              </button>
            </div>
            {/* Tabela de componentes */}
            <div className="overflow-y-auto flex-1 p-5">
              {kitViewModal.comps.length === 0 ? (
                <div className="p-8 text-center text-gray-400 italic text-sm">Nenhum componente cadastrado</div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-50 text-gray-500 uppercase text-[10px] font-bold">
                      <th className="text-left px-3 py-2 rounded-l">Nº Comp.</th>
                      <th className="text-left px-3 py-2">Produto</th>
                      <th className="text-left px-3 py-2">Descrição</th>
                      <th className="text-right px-3 py-2">Qtd</th>
                      <th className="text-center px-3 py-2">Unid.</th>
                      <th className="text-center px-3 py-2">Extrus.</th>
                      <th className="text-right px-3 py-2 rounded-r">Peso Lin.</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {kitViewModal.comps.sort((a,b) => (a.ordem||0)-(b.ordem||0)).map((c, i) => (
                      <tr key={c.id || i} className={`hover:bg-blue-50 transition-colors ${c.numero_componente ? 'font-semibold bg-gray-50/60' : ''}`}>
                        <td className="px-3 py-2 font-mono text-blue-700">{c.numero_componente || ''}</td>
                        <td className="px-3 py-2 font-mono text-gray-700">{c.produto || ''}</td>
                        <td className="px-3 py-2 text-gray-600 max-w-[200px] truncate">{c.descricao || ''}</td>
                        <td className="px-3 py-2 text-right font-bold text-gray-800">{c.quantidade_por_kit != null ? Number(c.quantidade_por_kit).toLocaleString('pt-BR', {maximumFractionDigits:3}) : ''}</td>
                        <td className="px-3 py-2 text-center text-gray-500">{c.unidade || ''}</td>
                        <td className="px-3 py-2 text-center">{c.extrusado ? <span className="px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded text-[9px] font-bold">{c.extrusado}</span> : <span className="text-gray-300">—</span>}</td>
                        <td className="px-3 py-2 text-right text-gray-500">{c.peso_linear != null && c.peso_linear !== '' ? Number(c.peso_linear).toFixed(4) : <span className="text-gray-300">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {/* Footer */}
            <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-gray-100 bg-gray-50 rounded-b-2xl">
              <span className="text-xs text-gray-400">{kitViewModal.comps.filter(c => c.extrusado).length} itens extrusados</span>
              <div className="flex gap-2">
                <button
                  onClick={() => { setKitViewModal(null) }}
                  className="px-4 py-2 rounded-lg border border-gray-300 text-xs font-bold text-gray-600 hover:bg-gray-100 transition-all"
                >Fechar</button>
                <button
                  onClick={() => {
                    const compsKit = kitViewModal.comps
                    setKitForm(kitViewModal.kit)
                    setComponentesForm(compsKit.map((c) => ({
                      tempId: createTempId(),
                      numero_componente: c.numero_componente || '',
                      produto: c.produto,
                      descricao: c.descricao || '',
                      comprimento: c.comprimento || '',
                      quantidade_por_kit: String(c.quantidade_por_kit),
                      unidade: c.unidade || 'UN',
                      extrusado: c.extrusado || '',
                      peso_linear: c.peso_linear != null ? String(c.peso_linear) : '',
                      ordem: c.ordem,
                      origem: c.origem || 'usinagem',
                    })))
                    setKitViewModal(null)
                  }}
                  className="px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 transition-all flex items-center gap-1.5"
                ><FaEdit className="w-3 h-3" /> Editar Kit</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Gerador de Romaneio */}
      <GeradorRomaneio
        isOpen={geradorRomaneioAberto}
        onClose={() => setGeradorRomaneioAberto(false)}
        apontamentos={apontamentos}
        kits={kitsComComponentes}
        onGerarRomaneio={async (dadosRomaneio) => {
          console.log('📋 Gerando romaneio:', dadosRomaneio)
          
          try {
            // Gerar número de romaneio no padrão: ROM-DDMMYYYY-NNNN
            const agora = new Date()
            const dia = String(agora.getDate()).padStart(2, '0')
            const mes = String(agora.getMonth() + 1).padStart(2, '0')
            const ano = agora.getFullYear()
            const sequencial = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
            const numeroRomaneio = `ROM-${dia}${mes}${ano}-${sequencial}`

            // Calcular totais para o romaneio
            const totalPecas = dadosRomaneio.paletesParaSeparar.reduce((sum, p) => sum + (p.quantidadeNecessaria || 0), 0)
            const racksUnicos = new Set(dadosRomaneio.paletesParaSeparar.map(p => p.rack).filter(Boolean))

            // Criar romaneio
            const romaneioData = {
              numero_romaneio: numeroRomaneio,
              cliente: dadosRomaneio.cliente,
              kit_id: dadosRomaneio.kitId,
              kit_codigo: dadosRomaneio.kitCodigo,
              kit_nome: dadosRomaneio.kitNome,
              quantidade_kits: dadosRomaneio.quantidadeKits,
              status: 'pendente',
              total_racks: racksUnicos.size,
              total_pecas: totalPecas,
              observacoes: `Romaneio gerado para ${dadosRomaneio.quantidadeKits} kits de ${dadosRomaneio.kitNome}`,
            }

            console.log('💾 Salvando romaneio:', romaneioData)
            
            // Salvar romaneio na tabela expedicao_romaneios
            const novoRomaneioId = await supabaseService.add('expedicao_romaneios', romaneioData)
            console.log('✅ Romaneio criado com ID:', novoRomaneioId)

            // Salvar itens do romaneio - buscar dados do apontamento original
            const itensRomaneio = dadosRomaneio.paletesParaSeparar.map(palete => {
              // Buscar apontamento original para pegar cliente, pedido, lote
              const apontamentoOriginal = apontamentos.find(apt => apt.id === palete.apontamentoId)
              
              // Calcular peso estimado
              // peso = peso_linear (kg/m) × comprimento (m) × quantidade
              let pesoEstimadoKg = 0
              if (ferramentasCfg && ferramentasCfg.length > 0) {
                // Buscar configuração da ferramenta
                const cfgFerramenta = ferramentasCfg.find(cfg => 
                  String(cfg.ferramenta || '').toUpperCase() === String(palete.ferramenta || '').toUpperCase()
                )
                
                if (cfgFerramenta && cfgFerramenta.peso_linear) {
                  const pesoLinear = Number(cfgFerramenta.peso_linear) || 0
                  const comprimentoM = (parseInt(palete.comprimento) || 0) / 1000
                  const quantidade = palete.quantidadeNecessaria || 0
                  pesoEstimadoKg = pesoLinear * comprimentoM * quantidade
                }
              }
              
              // rack_acabado é o nome real do palete (ex: USI-1246)
              const nomeRack = apontamentoOriginal?.rack_acabado || apontamentoOriginal?.rackAcabado
                || apontamentoOriginal?.rack_ou_pallet || apontamentoOriginal?.rackOuPallet
                || palete.rack || 'RACK-DESCONHECIDO'

              console.log(`🔍 Buscando apontamento:`, {
                apontamentoId: palete.apontamentoId,
                encontrado: !!apontamentoOriginal,
                rack: nomeRack,
                pesoEstimado: pesoEstimadoKg,
              })
              
              return {
                romaneio_id: novoRomaneioId,
                ferramenta: palete.ferramenta,
                comprimento: palete.comprimento,
                comprimento_acabado_mm: parseInt(palete.comprimento) || 0,
                produto: palete.produtoOriginal,
                rack_ou_pallet: nomeRack,
                quantidade: palete.quantidadeNecessaria,
                apontamento_id: palete.apontamentoId,
                cliente: apontamentoOriginal?.cliente || dadosRomaneio.cliente,
                pedido_seq: apontamentoOriginal?.pedido_seq || '-',
                pedido_cliente: apontamentoOriginal?.pedido_cliente || apontamentoOriginal?.pedidoCliente || '-',
                lote: apontamentoOriginal?.lote || '-',
                lote_externo: apontamentoOriginal?.lote_externo || '-',
                peso_estimado_kg: pesoEstimadoKg > 0 ? Number(pesoEstimadoKg.toFixed(3)) : null,
                status_item: 'pendente',
                tipo_item: 'rack',
              }
            })

            console.log('📦 Salvando itens do romaneio:', itensRomaneio.length)
            
            // Calcular peso total estimado
            const pesoTotalEstimado = itensRomaneio.reduce((sum, item) => {
              return sum + (item.peso_estimado_kg || 0)
            }, 0)
            
            console.log('⚖️ Peso total estimado:', pesoTotalEstimado, 'kg')
            
            // Atualizar romaneio com peso total
            if (pesoTotalEstimado > 0) {
              await supabaseService.update('expedicao_romaneios', {
                id: novoRomaneioId,
                peso_total_estimado_kg: Number(pesoTotalEstimado.toFixed(3))
              })
              console.log('✅ Peso total atualizado no romaneio')
            }
            
            if (itensRomaneio.length > 0) {
              await supabaseService.addMany('expedicao_romaneio_itens', itensRomaneio)
              console.log('✅ Itens do romaneio salvos')
            }

            // Marcar apontamentos com romaneio_numero para que não apareçam mais como disponíveis
            const apontamentoIds = dadosRomaneio.paletesParaSeparar
              .map(p => p.apontamentoId)
              .filter(Boolean)

            if (apontamentoIds.length > 0) {
              const { error: errMark } = await supabaseService.supabase
                .from('apontamentos')
                .update({ romaneio_numero: numeroRomaneio })
                .in('id', apontamentoIds)
              if (errMark) {
                console.warn('⚠️ Erro ao marcar apontamentos com romaneio:', errMark)
              } else {
                console.log(`✅ ${apontamentoIds.length} apontamento(s) marcados com romaneio ${numeroRomaneio}`)
              }
            }

            // Recarregar romaneios, itens e apontamentos para atualizar quantidades disponíveis
            if (loadRomaneios) await loadRomaneios()
            if (loadRomaneioItens) await loadRomaneioItens()
            if (loadApontamentos) await loadApontamentos()

            setGeradorRomaneioAberto(false)
            alert(`✅ Romaneio gerado com sucesso!\n\nKit: ${dadosRomaneio.kitNome}\nQuantidade: ${dadosRomaneio.quantidadeKits} kits\nTotal de itens: ${dadosRomaneio.resumo.totalUnidades} un`)
          } catch (error) {
            console.error('❌ Erro ao gerar romaneio:', error)
            alert('Erro ao gerar romaneio: ' + error.message)
          }
        }}
      />

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 5px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: #f1f1f1;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #cbd5e1;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #94a3b8;
        }
      `}</style>
    </div>
  )
}

export default KitsPanel
