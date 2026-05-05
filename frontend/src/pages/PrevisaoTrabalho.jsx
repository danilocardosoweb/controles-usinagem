import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { FaClock, FaCalculator, FaChartLine, FaPlus, FaTrash, FaBusinessTime, FaSave, FaFileImport, FaProjectDiagram, FaList, FaIndustry, FaWeight, FaBars } from 'react-icons/fa'
import { useSupabase } from '../hooks/useSupabase'
import supabaseService from '../services/SupabaseService'

const PrevisaoTrabalho = () => {
  const [abaSelecionada, setAbaSelecionada] = useState('carteira')
  const [filtros, setFiltros] = useState({
    produto: '',
    maquina: '',
    operador: ''
  })
  // Tipo de dia para estimativa: dia útil ou sábado
  const [tipoDia, setTipoDia] = useState('dia_util')
  
  // Modo de cálculo de produtividade
  const [modoProdutividade, setModoProdutividade] = useState('historica') // 'historica' | 'estimativa'
  const [estimativaPcsPorDia, setEstimativaPcsPorDia] = useState(20000)
  
  // Data inicial para previsões
  const [dataInicialPrevisao, setDataInicialPrevisao] = useState(() => {
    const hoje = new Date()
    const y = hoje.getFullYear()
    const m = String(hoje.getMonth() + 1).padStart(2, '0')
    const d = String(hoje.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  })
  
  // Novos pedidos para estimativa manual
  const [novosPedidos, setNovosPedidos] = useState([])
  const [novoPedido, setNovoPedido] = useState({
    quantidade: '',
    produtividadeManual: '',
    ferramenta: '',
    comprimentoMm: ''
  })
  const [mostrarCotacao, setMostrarCotacao] = useState(false)
  // Controles da visualização Gantt
  const [ganttZoomPX, setGanttZoomPX] = useState(36) // px por dia
  const [ganttOrdenacao, setGanttOrdenacao] = useState('prazo') // 'prazo' | 'estimativa' | 'sequencia'
  const [ganttSombrarFds, setGanttSombrarFds] = useState(true)
  const [filtrosExpandidos, setFiltrosExpandidos] = useState(true)
  const [apenasSaldoPositivo, setApenasSaldoPositivo] = useState(true)
  const [mostrarFormManual, setMostrarFormManual] = useState(false)
  const [mostrarEstimativaImportados, setMostrarEstimativaImportados] = useState(false)
  const [estimativaPcsDiaImportados, setEstimativaPcsDiaImportados] = useState(15000)
  const [dataInicioImportadosModo, setDataInicioImportadosModo] = useState('carteira') // 'carteira' | 'manual'
  const [dataInicioImportados, setDataInicioImportados] = useState(() => {
    const h = new Date()
    const y = h.getFullYear(); const m = String(h.getMonth()+1).padStart(2,'0'); const d = String(h.getDate()).padStart(2,'0')
    return `${y}-${m}-${d}`
  })

  // Filtros e seleção de pedidos da carteira
  const [filtroPedidoCliente, setFiltroPedidoCliente] = useState('')
  const [pedidosSelecionados, setPedidosSelecionados] = useState([]) // array de pedido_seq

  const [filaAgruparPor, setFilaAgruparPor] = useState('cliente') // 'cliente' | 'pedido_cliente' | 'pedido_seq'
  const [filaCenario, setFilaCenario] = useState('atual') // 'atual' | 'sim1'
  const [filaAtualIds, setFilaAtualIds] = useState([])
  const [filaSim1Ids, setFilaSim1Ids] = useState([])
  const [filaGruposRecolhidos, setFilaGruposRecolhidos] = useState({ cliente: [], pedido_cliente: [] })

  // Calculadora de Extrusão
  const [calcExtrusaoItens, setCalcExtrusaoItens] = useState([{ id: 1, ferramenta: '', comprimentoAcabado: '', qtdPecas: '', comprimentoBarra: 6000 }])
  const [calcExtrusaoProximoId, setCalcExtrusaoProximoId] = useState(2)
  const [mostrarModalExportarFila, setMostrarModalExportarFila] = useState(false)
  const [dataExportarFila, setDataExportarFila] = useState(() => {
    const hoje = new Date()
    const y = hoje.getFullYear()
    const m = String(hoje.getMonth() + 1).padStart(2, '0')
    const d = String(hoje.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  })

  // Turnos de trabalho
  const [turnos, setTurnos] = useState([
    { id: 'TA', nome: 'Turno A', horasTrabalho: 8, horasParadas: 0, ativo: true },
    { id: 'TB', nome: 'Turno B', horasTrabalho: 8, horasParadas: 0, ativo: true },
    { id: 'TC', nome: 'Turno C', horasTrabalho: 8, horasParadas: 0, ativo: true }
  ])
  
  const [turnoEditando, setTurnoEditando] = useState(null)
  // Horas extras
  const [extrasDiaUtil, setExtrasDiaUtil] = useState(0)
  const [extrasSabado, setExtrasSabado] = useState(0)

  // Dados do sistema
  const { items: apontamentos } = useSupabase('apontamentos')
  const { items: pedidos } = useSupabase('pedidos')
  const { items: maquinas } = useSupabase('maquinas')
  const { items: ferramentasCfg } = useSupabase('ferramentas_cfg')
  const { items: carteiraEncomendas } = useSupabase('carteira_encomendas')
  
  // Importar planilha de cotação
  // Formato específico informado:
  // - Cabeçalho na linha 20 (1-index)
  // - Dados começam na linha 21
  // - Coluna C = Ferramenta, F = Comprimento (mm), I = Quantidade (pcs)
  // Observação: também suportamos CSV/XLSX genéricos (fallback)
  const importarCotacaoArquivo = async (file) => {
    if (!file) return
    try {
      const XLSX = await import('xlsx')
      const data = await file.arrayBuffer()
      const wb = XLSX.read(data, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const adicionados = []

      if (ws['!ref']) {
        // Tentar o formato específico por colunas
        const range = XLSX.utils.decode_range(ws['!ref'])
        // Dados a partir da linha 21 (1-index) => índice base 0: 20
        for (let r = 20; r <= range.e.r; r++) {
          // Parar quando encontrar a linha de totalização
          const hasStopMarker = ['A','B','C','D','E','F','G','H','I','J','K','L'].some(col => {
            const val = ws[col + (r + 1)]?.v
            return String(val || '').toLowerCase().includes('valor total pedido')
          })
          if (hasStopMarker) break
          const cellFerr = ws['C' + (r + 1)]
          const cellComp = ws['F' + (r + 1)]
          const cellQtd = ws['I' + (r + 1)]

          const ferramenta = (cellFerr?.v ?? '').toString().trim()
          const comprimentoMmRaw = cellComp?.v
          const quantidadeRaw = cellQtd?.v

          const comprimentoMm = comprimentoMmRaw != null && comprimentoMmRaw !== ''
            ? String(comprimentoMmRaw).toString().replace(',', '.')
            : ''
          const quantidade = quantidadeRaw != null && quantidadeRaw !== ''
            ? parseFloat(String(quantidadeRaw).toString().replace(',', '.')) || 0
            : 0

          // Ignorar linha se não houver quantidade e ferramenta
          if (!ferramenta && quantidade <= 0) continue

          // Preencher produto com a própria ferramenta (ajustável depois se necessário)
          const produto = ferramenta
          const descricao = ''
          const produtividadeManual = 0

          // Calcular com produtividade histórica se existir
          let estimativaHoras = 0
          let estimativaDias = 0
          let confiabilidade = 'Manual'
          const prodHist = produtividadePorProduto[produto]
          if (quantidade > 0) {
            if (prodHist && prodHist.pcsPorHora > 0) {
              estimativaHoras = quantidade / prodHist.pcsPorHora
              estimativaDias = estimativaHoras / (horasUteisSelecionadas || 1)
              confiabilidade = 'Histórica'
            } else {
              estimativaHoras = 0
              estimativaDias = 0
            }
          }

          adicionados.push({
            id: Date.now() + Math.random(),
            produto,
            descricao,
            quantidade,
            produtividadeManual,
            ferramenta,
            comprimentoMm,
            estimativaHoras: estimativaHoras.toFixed(2),
            estimativaDias: estimativaDias.toFixed(2),
            confiabilidade
          })
        }
      }

      // Fallback: se nada foi adicionado, tentar parse genérico
      if (adicionados.length === 0) {
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
        for (const r of rows) {
          // Parar quando encontrar a linha de totalização
          const rowString = Object.values(r).map(v => String(v || '').toLowerCase()).join(' | ')
          if (rowString.includes('valor total pedido')) break
          const produto = String(r.produto || r.Produto || '').trim()
          const descricao = String(r.descricao || r.Descricao || '').trim()
          const quantidade = parseFloat(r.quantidade || r.Qtd || r.volume || r.Volume || 0) || 0
          const produtividadeManual = parseFloat(r.produtividade || r['produtividade (pcs/h)'] || 0) || 0
          const ferramenta = String(r.ferramenta || r.Ferramenta || '').trim()
          const comprimentoMm = String(r.comprimento_mm || r.Comprimento || r['Comprimento (mm)'] || '').trim()
          if (!produto && !ferramenta) return
          if (!quantidade) return
          let estimativaHoras = 0
          let estimativaDias = 0
          let confiabilidade = 'Manual'
          if (produtividadeManual > 0) {
            estimativaHoras = quantidade / produtividadeManual
            estimativaDias = estimativaHoras / (horasUteisSelecionadas || 1)
          } else {
            const prodHist = produtividadePorProduto[produto]
            if (prodHist && prodHist.pcsPorHora > 0) {
              estimativaHoras = quantidade / prodHist.pcsPorHora
              estimativaDias = estimativaHoras / (horasUteisSelecionadas || 1)
              confiabilidade = 'Histórica'
            }
          }
          adicionados.push({
            id: Date.now() + Math.random(),
            produto: produto || ferramenta,
            descricao,
            quantidade,
            produtividadeManual,
            ferramenta,
            comprimentoMm,
            estimativaHoras: estimativaHoras.toFixed(1),
            estimativaDias: estimativaDias.toFixed(1),
            confiabilidade
          })
        }
      }

      if (adicionados.length) {
        setNovosPedidos(prev => [...prev, ...adicionados])
        setMostrarCotacao(false)
      }
    } catch (e) {
      console.error('Falha ao importar cotação:', e)
    }
  }

  // Carregar turnos, extras e configurações a partir do Supabase (fallback: localStorage)
  useEffect(() => {
    ;(async () => {
      // Turnos
      try {
        const turnosCfg = await supabaseService.obterConfiguracao('previsao_turnos')
        if (turnosCfg) {
          const parsed = Array.isArray(turnosCfg)
            ? turnosCfg
            : (typeof turnosCfg === 'string' ? JSON.parse(turnosCfg) : null)
          if (Array.isArray(parsed) && parsed.length) {
            setTurnos(parsed)
          }
        } else {
          const turnosSalvos = localStorage.getItem('previsao_turnos')
          if (turnosSalvos) {
            const parsed = JSON.parse(turnosSalvos)
            if (Array.isArray(parsed) && parsed.length) setTurnos(parsed)
          }
        }
      } catch {}

      // Extras
      try {
        const extrasCfg = await supabaseService.obterConfiguracao('previsao_extras')
        const obj = extrasCfg
          ? (typeof extrasCfg === 'string' ? JSON.parse(extrasCfg) : extrasCfg)
          : (() => {
            const extras = localStorage.getItem('previsao_extras')
            return extras ? JSON.parse(extras) : null
          })()
        if (obj && typeof obj === 'object') {
          if (typeof obj.extrasDiaUtil === 'number') setExtrasDiaUtil(obj.extrasDiaUtil)
          if (typeof obj.extrasSabado === 'number') setExtrasSabado(obj.extrasSabado)
        }
      } catch {}

      // Produtividade
      try {
        const prodCfg = await supabaseService.obterConfiguracao('previsao_produtividade')
        const obj = prodCfg
          ? (typeof prodCfg === 'string' ? JSON.parse(prodCfg) : prodCfg)
          : (() => {
            const configProd = localStorage.getItem('previsao_produtividade')
            return configProd ? JSON.parse(configProd) : null
          })()
        if (obj && typeof obj === 'object') {
          if (obj.modo) setModoProdutividade(obj.modo)
          if (typeof obj.estimativaPcsPorDia === 'number' && obj.estimativaPcsPorDia > 0) {
            setEstimativaPcsPorDia(obj.estimativaPcsPorDia)
          }
        } else {
          setEstimativaPcsPorDia(20000)
        }
      } catch {
        setEstimativaPcsPorDia(20000)
      }

      // Fila de Produção
      try {
        const filaAtualCfg = await supabaseService.obterConfiguracao('previsao_fila_atual')
        if (filaAtualCfg) {
          const parsed = typeof filaAtualCfg === 'string' ? JSON.parse(filaAtualCfg) : filaAtualCfg
          if (Array.isArray(parsed)) setFilaAtualIds(parsed)
        } else {
          const ls = localStorage.getItem('previsao_fila_atual')
          if (ls) {
            const parsed = JSON.parse(ls)
            if (Array.isArray(parsed)) setFilaAtualIds(parsed)
          }
        }
      } catch {}
      try {
        const filaSimCfg = await supabaseService.obterConfiguracao('previsao_fila_sim1')
        if (filaSimCfg) {
          const parsed = typeof filaSimCfg === 'string' ? JSON.parse(filaSimCfg) : filaSimCfg
          if (Array.isArray(parsed)) setFilaSim1Ids(parsed)
        } else {
          const ls = localStorage.getItem('previsao_fila_sim1')
          if (ls) {
            const parsed = JSON.parse(ls)
            if (Array.isArray(parsed)) setFilaSim1Ids(parsed)
          }
        }
      } catch {}
      try {
        const filaAgruparCfg = await supabaseService.obterConfiguracao('previsao_fila_agrupar_por')
        const v = filaAgruparCfg
          ? (typeof filaAgruparCfg === 'string' ? JSON.parse(filaAgruparCfg) : filaAgruparCfg)
          : (() => {
            const ls = localStorage.getItem('previsao_fila_agrupar_por')
            return ls ? JSON.parse(ls) : null
          })()
        if (v === 'cliente' || v === 'pedido_cliente' || v === 'pedido_seq') setFilaAgruparPor(v)
      } catch {}

      try {
        const filaGrpCfg = await supabaseService.obterConfiguracao('previsao_fila_grupos_recolhidos')
        const v = filaGrpCfg
          ? (typeof filaGrpCfg === 'string' ? JSON.parse(filaGrpCfg) : filaGrpCfg)
          : (() => {
            const ls = localStorage.getItem('previsao_fila_grupos_recolhidos')
            return ls ? JSON.parse(ls) : null
          })()
        if (v && typeof v === 'object') {
          const cliente = Array.isArray(v.cliente) ? v.cliente.map(String) : []
          const pedido_cliente = Array.isArray(v.pedido_cliente) ? v.pedido_cliente.map(String) : []
          setFilaGruposRecolhidos({ cliente, pedido_cliente })
        }
      } catch {}
    })()
  }, [])

  // Garantir 20.000 pcs/dia como padrão quando o modo for 'estimativa' e ainda não houver valor salvo
  useEffect(() => {
    if (modoProdutividade === 'estimativa' && (!estimativaPcsPorDia || estimativaPcsPorDia <= 0)) {
      setEstimativaPcsPorDia(20000)
      try { localStorage.setItem('previsao_produtividade', JSON.stringify({ modo: 'estimativa', estimativaPcsPorDia: 20000 })) } catch {}
    }
  }, [modoProdutividade])

  // Salvar turnos no localStorage
  const salvarTurnos = async (turnosPayload = null) => {
    const payload = Array.isArray(turnosPayload) ? turnosPayload : turnos
    try { await supabaseService.salvarConfiguracao('previsao_turnos', payload) } catch {}
    try { localStorage.setItem('previsao_turnos', JSON.stringify(payload)) } catch {}
  }
  const salvarExtras = async () => {
    const payload = { extrasDiaUtil, extrasSabado }
    try { await supabaseService.salvarConfiguracao('previsao_extras', payload) } catch {}
    try { localStorage.setItem('previsao_extras', JSON.stringify(payload)) } catch {}
  }
  const salvarConfigProdutividade = async (modoOverride, estimativaOverride) => {
    const payload = { modo: modoOverride ?? modoProdutividade, estimativaPcsPorDia: estimativaOverride ?? estimativaPcsPorDia }
    try { await supabaseService.salvarConfiguracao('previsao_produtividade', payload) } catch {}
    try { localStorage.setItem('previsao_produtividade', JSON.stringify(payload)) } catch {}
  }

  const salvarFilaAtual = async (ids) => {
    try { await supabaseService.salvarConfiguracao('previsao_fila_atual', ids) } catch {}
    try { localStorage.setItem('previsao_fila_atual', JSON.stringify(ids)) } catch {}
  }
  const salvarFilaSim1 = async (ids) => {
    try { await supabaseService.salvarConfiguracao('previsao_fila_sim1', ids) } catch {}
    try { localStorage.setItem('previsao_fila_sim1', JSON.stringify(ids)) } catch {}
  }
  const salvarFilaAgruparPor = async (v) => {
    try { await supabaseService.salvarConfiguracao('previsao_fila_agrupar_por', v) } catch {}
    try { localStorage.setItem('previsao_fila_agrupar_por', JSON.stringify(v)) } catch {}
  }
  const salvarFilaGruposRecolhidos = async (obj) => {
    try { await supabaseService.salvarConfiguracao('previsao_fila_grupos_recolhidos', obj) } catch {}
    try { localStorage.setItem('previsao_fila_grupos_recolhidos', JSON.stringify(obj)) } catch {}
  }

  // Calcular horas base e horas úteis por dia considerando extras e tipo de dia
  const horasBase = useMemo(() => {
    return turnos
      .filter(turno => turno.ativo)
      .reduce((total, turno) => total + (turno.horasTrabalho - turno.horasParadas), 0)
  }, [turnos])

  const horasUteisDiaUtil = useMemo(() => horasBase + (extrasDiaUtil || 0), [horasBase, extrasDiaUtil])
  // Para sábado, consideramos apenas as horas extras de sábado (caso a operação aconteça somente como hora extra)
  const horasUteisSabado = useMemo(() => (extrasSabado || 0), [extrasSabado])
  const horasUteisSelecionadas = tipoDia === 'sabado' ? horasUteisSabado : horasUteisDiaUtil

  // Helpers locais: extrair ferramenta e comprimento a partir do código do produto
  const extrairComprimentoAcabado = (produto) => {
    if (!produto) return ''
    const resto = String(produto).slice(8)
    const match = resto.match(/^\d+/)
    const valor = match ? parseInt(match[0], 10) : null
    return Number.isFinite(valor) ? `${valor} mm` : ''
  }
  const extrairFerramenta = (produto) => {
    if (!produto) return ''
    const s = String(produto).toUpperCase()
    const re3 = /^([A-Z]{3})([A-Z0-9]+)/
    const re2 = /^([A-Z]{2})([A-Z0-9]+)/
    let letras = '', resto = '', qtd = 0
    let m = s.match(re3)
    if (m) { letras = m[1]; resto = m[2]; qtd = 3 }
    else {
      m = s.match(re2)
      if (!m) return ''
      letras = m[1]; resto = m[2]; qtd = 4
    }
    let nums = ''
    for (const ch of resto) {
      if (/[0-9]/.test(ch)) nums += ch
      else if (ch === 'O') nums += '0'
      if (nums.length === qtd) break
    }
    if (nums.length < qtd) nums = nums.padEnd(qtd, '0')
    return `${letras}-${nums}`
  }

  const parseLocalDate = (s) => {
    const parts = (s || '').split('-').map(Number)
    const [y, m, d] = parts
    if (!y || !m || !d) return new Date(NaN)
    return new Date(y, m - 1, d)
  }
  const ptBrToYMD = (s) => {
    const [dd, mm, yyyy] = String(s || '').split('/')
    if (!dd || !mm || !yyyy) return ''
    return `${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`
  }

  // Mapeamento de máquinas (ID -> Nome)
  const maquinasMap = useMemo(() => {
    const map = {}
    if (maquinas && maquinas.length > 0) {
      maquinas.forEach(maq => {
        if (maq.id && maq.nome) {
          map[String(maq.id)] = maq.nome
        }
      })
    }
    return map
  }, [maquinas])

  // Cálculo de produtividade baseado em apontamentos históricos
  const produtividadePorProduto = useMemo(() => {
    const stats = {}
    
    if (!apontamentos || apontamentos.length === 0) return stats

    apontamentos.forEach(apont => {
      if (!apont.produto || !apont.quantidade || !apont.inicio || !apont.fim) return
      
      const inicio = new Date(apont.inicio)
      const fim = new Date(apont.fim)
      const horasTrabalhadas = (fim - inicio) / (1000 * 60 * 60) // em horas
      
      if (horasTrabalhadas <= 0) return
      
      const produto = apont.produto
      const quantidade = parseFloat(apont.quantidade) || 0
      const pcsPorHora = quantidade / horasTrabalhadas
      
      if (!stats[produto]) {
        stats[produto] = {
          produto,
          totalPcs: 0,
          totalHoras: 0,
          registros: 0,
          maquinas: new Set(),
          operadores: new Set()
        }
      }
      
      stats[produto].totalPcs += quantidade
      stats[produto].totalHoras += horasTrabalhadas
      stats[produto].registros += 1
      // Usar nome da máquina em vez do ID
      const nomeMaquina = maquinasMap[String(apont.maquina)] || apont.maquina || 'N/A'
      stats[produto].maquinas.add(nomeMaquina)
      stats[produto].operadores.add(apont.operador)
    })

    // Calcular médias
    Object.keys(stats).forEach(produto => {
      const stat = stats[produto]
      stat.pcsPorHora = stat.totalPcs / stat.totalHoras
      // pcs/dia depende do tipo de dia selecionado (dia útil ou sábado)
      stat.pcsPorDia = stat.pcsPorHora * horasUteisSelecionadas
      stat.maquinasArray = Array.from(stat.maquinas)
      stat.operadoresArray = Array.from(stat.operadores)
    })

    return stats
  }, [apontamentos, horasUteisSelecionadas, maquinasMap])

  // Mapa de produtividade teórica (pcs/h) por ferramenta
  const teoricoPorFerramenta = useMemo(() => {
    const map = {}
    if (!ferramentasCfg || ferramentasCfg.length === 0) return map
    for (const cfg of ferramentasCfg) {
      const key = String(cfg.ferramenta || '').trim().toUpperCase()
      if (!key) continue
      const val = parseFloat(cfg.teorico_produtividade_pcs_hora)
      if (!Number.isFinite(val) || val <= 0) continue
      map[key] = val
    }
    return map
  }, [ferramentasCfg])

  // Contadores para estatísticas
  const estatisticasPedidos = useMemo(() => {
    if (!pedidos || pedidos.length === 0) return { total: 0, concluidos: 0, saldoNegativo: 0, validos: 0 }
    
    const total = pedidos.length
    const concluidos = pedidos.filter(p => p.status === 'concluido').length
    const saldoNegativo = pedidos.filter(p => p.status !== 'concluido' && parseFloat(p.saldo_a_prod) <= 0).length
    const validos = pedidos.filter(p => p.status !== 'concluido' && parseFloat(p.saldo_a_prod) > 0).length
    
    return { total, concluidos, saldoNegativo, validos }
  }, [pedidos])

  // Estimativa para pedidos da carteira (lista exibida - NÃO filtra por seleção)
  const estimativaCarteira = useMemo(() => {
    if (!pedidos || pedidos.length === 0) return []
    
    let base = pedidos
      .filter(p => !filtroPedidoCliente || (p.pedido_cliente || '').toLowerCase().includes(filtroPedidoCliente.toLowerCase()))

    return base
      .map(pedido => {
        const produtividade = produtividadePorProduto[pedido.produto]
        const qtdPedido = parseFloat(pedido.qtd_pedido) || 0
        const separado = parseFloat(pedido.separado) || 0

        // Saldo real = Qtd. Pedido - Separado
        const saldoBaseRaw = qtdPedido - separado

        const saldoProduzir = Math.max(0, saldoBaseRaw)

        const ferramentaDoProduto = extrairFerramenta(pedido.produto)
        const teoricoPcsHora = ferramentaDoProduto
          ? (teoricoPorFerramenta[String(ferramentaDoProduto).toUpperCase()] ?? null)
          : null
        
        let estimativaHoras = 0
        let estimativaDias = 0
        let confiabilidade = 'Baixa'
        
        if (modoProdutividade === 'estimativa') {
          // Usar estimativa manual (peças por dia)
          if (saldoProduzir > 0 && estimativaPcsPorDia > 0) {
            // Cálculo correto: Dias = Peças / (Peças por dia)
            estimativaDias = saldoProduzir / estimativaPcsPorDia
            // Horas = Dias * Horas úteis por dia
            estimativaHoras = estimativaDias * (horasUteisSelecionadas || 24)
            confiabilidade = 'Estimativa'
          }
        } else {
          // Usar produtividade histórica (peças por hora), com fallback para Teórico (pcs/h)
          if (saldoProduzir > 0) {
            const histOk = produtividade && produtividade.pcsPorHora > 0 && (produtividade.registros || 0) >= 2
            const taxaPcsHora = histOk
              ? produtividade.pcsPorHora
              : (teoricoPcsHora && teoricoPcsHora > 0 ? teoricoPcsHora : 0)

            if (taxaPcsHora > 0) {
              // Cálculo: Horas = Peças / (Peças por hora)
              estimativaHoras = saldoProduzir / taxaPcsHora
              // Dias = Horas / Horas úteis por dia
              estimativaDias = estimativaHoras / (horasUteisSelecionadas || 24)
              confiabilidade = histOk
                ? (produtividade.registros >= 5 ? 'Alta' : 'Média')
                : 'Teórica'
            }
          }
        }
        
        return {
          ...pedido,
          produtividade,
          teoricoPcsHora,
          estimativaHoras: estimativaHoras.toFixed(2),
          estimativaDias: estimativaDias.toFixed(2),
          confiabilidade,
          qtdPedido,
          saldoBaseRaw,
          saldoProduzir
        }
      })
      .sort((a, b) => new Date(a.dt_fatura) - new Date(b.dt_fatura))
  }, [pedidos, produtividadePorProduto, filtroPedidoCliente, horasUteisSelecionadas, modoProdutividade, estimativaPcsPorDia, teoricoPorFerramenta])

  const estimativaCarteiraExibicao = useMemo(() => {
    if (!apenasSaldoPositivo) return estimativaCarteira
    return estimativaCarteira.filter(p => {
      const v = Number(p.saldoBaseRaw ?? p.saldoAProd ?? p.saldo_a_prod ?? 0)
      return Number.isFinite(v) && v >= 0
    })
  }, [estimativaCarteira, apenasSaldoPositivo])

  const resumoCarteiraSaldo = useMemo(() => {
    const total = estimativaCarteira.length
    const saldoPos = estimativaCarteira.reduce((acc, p) => {
      const v = Number(p.saldoBaseRaw ?? p.saldoAProd ?? p.saldo_a_prod ?? 0)
      return acc + (Number.isFinite(v) && v >= 0 ? 1 : 0)
    }, 0)
    return { total, saldoPos }
  }, [estimativaCarteira])

  // Itens efetivamente considerados no cálculo (quando há seleção, usa apenas selecionados)
  const itensParaCalculo = useMemo(() => {
    if (pedidosSelecionados.length === 0) return estimativaCarteiraExibicao
    const setSel = new Set(pedidosSelecionados)
    return estimativaCarteiraExibicao.filter(p => setSel.has(p.pedido_seq))
  }, [estimativaCarteiraExibicao, pedidosSelecionados])

  // Filtrar dados
  const dadosFiltrados = useMemo(() => {
    let dados = abaSelecionada === 'carteira' ? estimativaCarteiraExibicao : novosPedidos
    
    if (filtros.produto) {
      dados = dados.filter(item => 
        item.produto?.toLowerCase().includes(filtros.produto.toLowerCase())
      )
    }
    
    return dados
  }, [estimativaCarteiraExibicao, novosPedidos, filtros, abaSelecionada])

  const filaBaseItens = useMemo(() => {
    return (estimativaCarteiraExibicao || []).filter(p => {
      const id = p.pedido_seq
      return id !== null && id !== undefined && String(id).trim() !== ''
    })
  }, [estimativaCarteiraExibicao])

  const filaBasePorId = useMemo(() => {
    const map = new Map()
    for (const p of filaBaseItens) {
      map.set(String(p.pedido_seq), p)
    }
    return map
  }, [filaBaseItens])

  const filaBaseIdsDefault = useMemo(() => filaBaseItens.map(p => String(p.pedido_seq)), [filaBaseItens])

  useEffect(() => {
    if (!filaBaseIdsDefault.length) return
    setFilaAtualIds(prev => {
      if (Array.isArray(prev) && prev.length) return prev
      return filaBaseIdsDefault
    })
  }, [filaBaseIdsDefault])

  const filaIdsAtivas = useMemo(() => {
    const idsRaw = filaCenario === 'sim1' ? filaSim1Ids : filaAtualIds
    const ids = Array.isArray(idsRaw) ? idsRaw.map(String) : []
    const setBase = new Set(filaBaseIdsDefault)
    const filtered = ids.filter(id => setBase.has(id))
    const missing = filaBaseIdsDefault.filter(id => !filtered.includes(id))
    return [...filtered, ...missing]
  }, [filaCenario, filaSim1Ids, filaAtualIds, filaBaseIdsDefault])

  const filaItensOrdenados = useMemo(() => {
    const itens = []
    for (const id of filaIdsAtivas) {
      const p = filaBasePorId.get(String(id))
      if (p) itens.push(p)
    }
    return itens
  }, [filaIdsAtivas, filaBasePorId])

  // Mapa de busca para carteira de encomendas (PROCV por nr_pedido)
  const mapaCarteiraEncomendas = useMemo(() => {
    const mapa = new Map()
    if (carteiraEncomendas && carteiraEncomendas.length > 0) {
      for (const encomenda of carteiraEncomendas) {
        const chave = String(encomenda.nr_pedido || '').trim().toUpperCase()
        if (chave) {
          mapa.set(chave, encomenda)
        }
      }
    }
    return mapa
  }, [carteiraEncomendas])

  // Mapa de busca para carteira de encomendas (PROCV por produto)
  const mapaCarteiraEncomendasPorProduto = useMemo(() => {
    const mapa = new Map()
    if (carteiraEncomendas && carteiraEncomendas.length > 0) {
      for (const encomenda of carteiraEncomendas) {
        const chave = String(encomenda.produto || '').trim().toUpperCase()
        if (chave) {
          mapa.set(chave, encomenda)
        }
      }
    }
    return mapa
  }, [carteiraEncomendas])

  // Mapa de busca para carteira de encomendas (PROCV por nr_pedido com ferramentas sem "SF")
  const mapaCarteiraEncomendasPorNrPedidoSemSF = useMemo(() => {
    const mapa = new Map()
    if (carteiraEncomendas && carteiraEncomendas.length > 0) {
      for (const encomenda of carteiraEncomendas) {
        const nrPedido = String(encomenda.nr_pedido || '').trim().toUpperCase()
        const ferramenta = String(encomenda.ferramenta || '').trim().toUpperCase()
        // Filtrar apenas ferramentas que NÃO começam com "SF"
        if (nrPedido && ferramenta && !ferramenta.startsWith('SF')) {
          // Se já existe uma entrada para este nr_pedido, manter a primeira
          if (!mapa.has(nrPedido)) {
            mapa.set(nrPedido, encomenda)
          }
        }
      }
    }
    return mapa
  }, [carteiraEncomendas])

  const filaGrupos = useMemo(() => {
    const getKey = (p) => {
      if (filaAgruparPor === 'pedido_seq') return String(p.pedido_seq || '')
      if (filaAgruparPor === 'pedido_cliente') return String(p.pedido_cliente || 'Sem Pedido Cliente')
      return String(p.cliente || p.nome_cliente || 'Sem Cliente')
    }

    const map = new Map()
    const ordem = []
    for (const p of filaItensOrdenados) {
      const k = getKey(p)
      if (!map.has(k)) {
        map.set(k, [])
        ordem.push(k)
      }
      // Buscar dados da carteira usando pedido_cliente como nr_pedido
      const chaveCarteira = String(p.pedido_cliente || '').trim().toUpperCase()
      const dadosCarteira = mapaCarteiraEncomendas.get(chaveCarteira)
      
      // Buscar dados da carteira usando item_perfil como produto
      const chaveItemPerfil = String(p.item_perfil || '').trim().toUpperCase()
      const dadosCarteiraItemPerfil = mapaCarteiraEncomendasPorProduto.get(chaveItemPerfil)
      
      // Buscar dados da carteira usando pedido_cliente como nr_pedido (extrusão - sem "SF")
      const chaveNrPedidoSemSF = String(p.pedido_cliente || '').trim().toUpperCase()
      const dadosCarteiraFerramenta = mapaCarteiraEncomendasPorNrPedidoSemSF.get(chaveNrPedidoSemSF)
      
      map.get(k).push({
        ...p,
        carteira: dadosCarteira || null,
        carteiraItemPerfil: dadosCarteiraItemPerfil || null,
        carteiraFerramenta: dadosCarteiraFerramenta || null
      })
    }

    return ordem.map(k => ({ key: k, items: map.get(k) || [] }))
  }, [filaItensOrdenados, filaAgruparPor, mapaCarteiraEncomendas, mapaCarteiraEncomendasPorProduto, mapaCarteiraEncomendasPorNrPedidoSemSF])

  useEffect(() => {
    if (filaAgruparPor !== 'cliente' && filaAgruparPor !== 'pedido_cliente') return
    const keys = filaGrupos.map(g => String(g.key))
    if (!keys.length) return
    setFilaGruposRecolhidos(prev => {
      const atual = Array.isArray(prev[filaAgruparPor]) ? prev[filaAgruparPor].map(String) : []
      if (atual.length) return prev
      const next = { ...prev, [filaAgruparPor]: keys }
      salvarFilaGruposRecolhidos(next)
      return next
    })
  }, [filaAgruparPor, filaGrupos])

  const filaToggleGrupo = (key) => {
    if (filaAgruparPor !== 'cliente' && filaAgruparPor !== 'pedido_cliente') return
    const k = String(key)
    setFilaGruposRecolhidos(prev => {
      const atual = new Set((prev[filaAgruparPor] || []).map(String))
      if (atual.has(k)) atual.delete(k)
      else atual.add(k)
      const next = { ...prev, [filaAgruparPor]: Array.from(atual) }
      salvarFilaGruposRecolhidos(next)
      return next
    })
  }

  const distribuirHorasPorData = (itens, dataInicio, horasUteisDiaUtil, extrasSabado) => {
    const resultado = []
    const getCapacidadeDia = (dt) => {
      const dow = dt.getDay()
      if (dow >= 1 && dow <= 5) return Number(horasUteisDiaUtil || 0)
      if (dow === 6) return Number(extrasSabado || 0)
      return 0
    }
    const avancarParaProximoDia = (dt) => {
      const next = new Date(dt)
      next.setDate(next.getDate() + 1)
      return next
    }

    let dataAtual = parseLocalDate(dataInicio)
    if (isNaN(dataAtual.getTime())) dataAtual = new Date()

    let capacidadeRestante = getCapacidadeDia(dataAtual)

    for (const item of itens) {
      const horasEstimadas = Number(item.estimativaHoras || 0)

      if (!(horasEstimadas > 0)) {
        resultado.push({
          Ordem: resultado.length + 1,
          Grupo: item.grupo || '',
          PedidoSeq: item.pedido_seq || '',
          Cliente: item.cliente || item.nome_cliente || '',
          Produto: item.produto || '',
          QtdPedido: Number(item.qtd_pedido || 0),
          SaldoProduzir: Number(item.saldoProduzir || 0),
          Separado: Number(item.separado || 0),
          ItemPerfil: item.item_perfil || '',
          EstimativaHoras: 0,
          DataInicio: dataAtual.toLocaleDateString('pt-BR'),
          DataFim: dataAtual.toLocaleDateString('pt-BR'),
          DiasUteis: 0,
          Sabados: 0
        })
        continue
      }

      let horasRestantes = horasEstimadas
      let dataInicioItem = null
      let dataFimItem = null
      const diasUsados = new Set()
      let sabados = 0

      while (horasRestantes > 0) {
        while (capacidadeRestante <= 0) {
          dataAtual = avancarParaProximoDia(dataAtual)
          capacidadeRestante = getCapacidadeDia(dataAtual)
        }

        if (!dataInicioItem) dataInicioItem = new Date(dataAtual)
        const keyDia = dataAtual.toISOString().slice(0, 10)
        if (!diasUsados.has(keyDia)) {
          diasUsados.add(keyDia)
          if (dataAtual.getDay() === 6) sabados++
        }

        const alocar = Math.min(horasRestantes, capacidadeRestante)
        horasRestantes -= alocar
        capacidadeRestante -= alocar
        dataFimItem = new Date(dataAtual)
      }

      const diasUteis = Array.from(diasUsados).filter(d => {
        const dt = parseLocalDate(d)
        const dow = dt.getDay()
        return dow >= 1 && dow <= 5
      }).length

      resultado.push({
        Ordem: resultado.length + 1,
        Grupo: item.grupo || '',
        PedidoSeq: item.pedido_seq || '',
        Cliente: item.cliente || item.nome_cliente || '',
        Produto: item.produto || '',
        QtdPedido: Number(item.qtd_pedido || 0),
        SaldoProduzir: Number(item.saldoProduzir || 0),
        Separado: Number(item.separado || 0),
        ItemPerfil: item.item_perfil || '',
        EstimativaHoras: horasEstimadas,
        DataInicio: (dataInicioItem || dataAtual).toLocaleDateString('pt-BR'),
        DataFim: (dataFimItem || dataAtual).toLocaleDateString('pt-BR'),
        DiasUteis: diasUteis,
        Sabados: sabados
      })
    }

    return resultado
  }

  const filaExportarExcel = async () => {
    try {
      const XLSX = await import('xlsx')
      const rows = filaItensOrdenados.map((p, idx) => {
        const grupo = filaAgruparPor === 'pedido_seq'
          ? String(p.pedido_seq || '')
          : (filaAgruparPor === 'pedido_cliente'
            ? String(p.pedido_cliente || 'Sem Pedido Cliente')
            : String(p.cliente || p.nome_cliente || 'Sem Cliente'))
        return {
          Ordem: idx + 1,
          Grupo: grupo,
          PedidoSeq: p.pedido_seq || '',
          Cliente: p.cliente || p.nome_cliente || '',
          PedidoCliente: p.pedido_cliente || '',
          Produto: p.produto || '',
          SaldoProduzir: Number(p.saldoProduzir || 0),
          EstimativaHoras: Number(p.estimativaHoras || 0),
          Confiabilidade: p.confiabilidade || '',
          Prazo: p.dt_fatura ? new Date(p.dt_fatura).toLocaleDateString('pt-BR') : ''
        }
      })
      
      const itensComGrupo = filaItensOrdenados.map((p, idx) => ({
        ...p,
        grupo: filaAgruparPor === 'pedido_seq'
          ? String(p.pedido_seq || '')
          : (filaAgruparPor === 'pedido_cliente'
            ? String(p.pedido_cliente || 'Sem Pedido Cliente')
            : String(p.cliente || p.nome_cliente || 'Sem Cliente'))
      }))
      
      const cronograma = distribuirHorasPorData(itensComGrupo, dataExportarFila, horasUteisDiaUtil, extrasSabado)
      
      const ws = XLSX.utils.json_to_sheet(rows)
      const wsCronograma = XLSX.utils.json_to_sheet(cronograma)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Fila')
      XLSX.utils.book_append_sheet(wb, wsCronograma, 'Cronograma')
      const nome = `fila_producao_${filaCenario}_${new Date().toISOString().slice(0,10)}.xlsx`
      XLSX.writeFile(wb, nome)
      setMostrarModalExportarFila(false)
    } catch (e) {
      console.error('Falha ao exportar Excel:', e)
    }
  }

  const filaResumo = useMemo(() => {
    const totalHoras = filaItensOrdenados.reduce((acc, p) => acc + (parseFloat(p.estimativaHoras) || 0), 0)
    const dias = totalHoras / (horasUteisSelecionadas || 1)
    return { totalHoras, dias, itens: filaItensOrdenados.length }
  }, [filaItensOrdenados, horasUteisSelecionadas])

  const filaArrastandoGrupoRef = useRef(false)

  const filaOnDragStart = (e, id) => {
    try { e.dataTransfer.setData('application/x-fila-drag', 'item') } catch {}
    try { e.dataTransfer.setData('text/plain', String(id)) } catch {}
  }
  const filaOnDrop = (e, dropId) => {
    e.preventDefault()
    const tipo = (() => {
      try { return e.dataTransfer.getData('application/x-fila-drag') } catch { return '' }
    })()
    if (tipo && tipo !== 'item') return
    const dragId = e.dataTransfer.getData('text/plain')
    if (!dragId || !dropId || String(dragId) === String(dropId)) return
    const ids = [...filaIdsAtivas]
    const from = ids.indexOf(String(dragId))
    const to = ids.indexOf(String(dropId))
    if (from < 0 || to < 0) return
    ids.splice(from, 1)
    ids.splice(to, 0, String(dragId))
    if (filaCenario === 'sim1') {
      setFilaSim1Ids(ids)
      salvarFilaSim1(ids)
    } else {
      setFilaAtualIds(ids)
      salvarFilaAtual(ids)
    }
  }
  const filaAllowDrop = (e) => e.preventDefault()

  const filaGrupoOnDragStart = (e, groupKey) => {
    filaArrastandoGrupoRef.current = true
    try { e.dataTransfer.setData('application/x-fila-drag', 'group') } catch {}
    try { e.dataTransfer.setData('text/plain', String(groupKey)) } catch {}
  }
  const filaGrupoOnDragEnd = () => {
    setTimeout(() => { filaArrastandoGrupoRef.current = false }, 0)
  }
  const filaGrupoOnDrop = (e, dropGroupKey) => {
    e.preventDefault()
    const tipo = (() => {
      try { return e.dataTransfer.getData('application/x-fila-drag') } catch { return '' }
    })()
    if (tipo !== 'group') return

    const dragGroupKey = (() => {
      try { return e.dataTransfer.getData('text/plain') } catch { return '' }
    })()
    if (!dragGroupKey || !dropGroupKey) return

    const fromKey = String(dragGroupKey)
    const toKey = String(dropGroupKey)
    if (fromKey === toKey) return

    const order = filaGrupos.map(g => String(g.key))
    const fromIdx = order.indexOf(fromKey)
    const toIdx = order.indexOf(toKey)
    if (fromIdx < 0 || toIdx < 0) return

    const nextOrder = [...order]
    nextOrder.splice(fromIdx, 1)
    nextOrder.splice(toIdx, 0, fromKey)

    const mapKeyToIds = new Map()
    for (const g of filaGrupos) {
      mapKeyToIds.set(String(g.key), (g.items || []).map(p => String(p.pedido_seq)))
    }
    const nextIds = nextOrder.flatMap(k => mapKeyToIds.get(k) || [])

    if (filaCenario === 'sim1') {
      setFilaSim1Ids(nextIds)
      salvarFilaSim1(nextIds)
    } else {
      setFilaAtualIds(nextIds)
      salvarFilaAtual(nextIds)
    }
    filaGrupoOnDragEnd()
  }

  const filaOrdenarPorDtFatura = () => {
    const ids = [...filaIdsAtivas]
    if (!ids.length) return

    const withMeta = ids.map((id, idx) => {
      const p = filaBasePorId.get(String(id))
      const raw = p?.dt_fatura
      const t = raw ? new Date(raw).getTime() : NaN
      return { id: String(id), idx, t: Number.isNaN(t) ? null : t }
    })

    withMeta.sort((a, b) => {
      if (a.t == null && b.t == null) return a.idx - b.idx
      if (a.t == null) return 1
      if (b.t == null) return -1
      if (a.t === b.t) return a.idx - b.idx
      return a.t - b.t
    })

    const nextIds = withMeta.map(x => x.id)
    if (filaCenario === 'sim1') {
      setFilaSim1Ids(nextIds)
      salvarFilaSim1(nextIds)
    } else {
      setFilaAtualIds(nextIds)
      salvarFilaAtual(nextIds)
    }
  }

  const filaCriarSimulacao = async () => {
    const base = [...filaAtualIds]
    setFilaSim1Ids(base)
    setFilaCenario('sim1')
    await salvarFilaSim1(base)
  }
  const filaAplicarSimulacao = async () => {
    const base = [...filaSim1Ids]
    setFilaAtualIds(base)
    setFilaCenario('atual')
    await salvarFilaAtual(base)
  }
  const filaDescartarSimulacao = async () => {
    setFilaSim1Ids([])
    setFilaCenario('atual')
    await salvarFilaSim1([])
  }

  const handleFiltroChange = (e) => {
    const { name, value } = e.target
    setFiltros(prev => ({ ...prev, [name]: value }))
  }

  const adicionarNovoPedido = () => {
    if (!novoPedido.ferramenta || !novoPedido.quantidade) return
    
    const quantidade = parseFloat(novoPedido.quantidade) || 0
    const produtividadeManual = parseFloat(novoPedido.produtividadeManual) || 0
    
    let estimativaHoras = 0
    let estimativaDias = 0
    let confiabilidade = 'Manual'
    const produtoRef = (novoPedido.ferramenta || '').trim()

    if (produtividadeManual > 0) {
      estimativaHoras = quantidade / produtividadeManual
      estimativaDias = estimativaHoras / (horasUteisSelecionadas || 1)
    } else if (modoProdutividade === 'estimativa') {
      // Usar estimativa manual (peças por dia)
      if (quantidade > 0 && estimativaPcsPorDia > 0) {
        // Cálculo correto: Dias = Peças / (Peças por dia)
        estimativaDias = quantidade / estimativaPcsPorDia
        // Horas = Dias * Horas úteis por dia
        estimativaHoras = estimativaDias * (horasUteisSelecionadas || 24)
        confiabilidade = 'Estimativa'
      }
    } else {
      // Tentar usar produtividade histórica (peças por hora)
      const produtividade = produtividadePorProduto[produtoRef]
      if (produtividade && produtividade.pcsPorHora > 0) {
        // Cálculo: Horas = Peças / (Peças por hora)
        estimativaHoras = quantidade / produtividade.pcsPorHora
        // Dias = Horas / Horas úteis por dia
        estimativaDias = estimativaHoras / (horasUteisSelecionadas || 24)
        confiabilidade = 'Histórica'
      }
    }
    
    const pedido = {
      id: Date.now(),
      produto: produtoRef, // interno, não exibido
      descricao: '',
      quantidade,
      produtividadeManual,
      ferramenta: novoPedido.ferramenta,
      comprimentoMm: novoPedido.comprimentoMm,
      estimativaHoras: estimativaHoras.toFixed(2),
      estimativaDias: estimativaDias.toFixed(2),
      confiabilidade
    }
    
    setNovosPedidos(prev => [...prev, pedido])
    setNovoPedido({
      quantidade: '',
      produtividadeManual: '',
      ferramenta: '',
      comprimentoMm: ''
    })
  }

  const removerNovoPedido = (id) => {
    setNovosPedidos(prev => prev.filter(p => p.id !== id))
  }

  const limparNovosPedidos = () => {
    if (!novosPedidos || novosPedidos.length === 0) return
    const ok = window.confirm('Deseja remover todas as estimativas manuais importadas/adicionadas?')
    if (!ok) return
    setNovosPedidos([])
  }

  const aplicarEstimativaImportados = () => {
    const pcsDia = parseFloat(estimativaPcsDiaImportados) || 0
    if (pcsDia <= 0) return setMostrarEstimativaImportados(false)
    let inicio = dataInicioImportados
    if (dataInicioImportadosModo === 'carteira' && terminoDetalhado?.data) {
      const ymd = ptBrToYMD(terminoDetalhado.data)
      if (ymd) inicio = ymd
    }
    setNovosPedidos(prev => prev.map(p => {
      const qtd = parseFloat(p.quantidade) || 0
      const semProdMan = !p.produtividadeManual || parseFloat(p.produtividadeManual) <= 0
      const semHist = !p.confiabilidade || p.confiabilidade === 'Manual' || Number(p.estimativaHoras) <= 0
      const alvo = qtd > 0 && semProdMan && semHist
      if (!alvo) return p
      const dias = qtd / pcsDia
      const horas = dias * (horasUteisSelecionadas || 1)
      return { ...p, estimativaHoras: horas.toFixed(2), estimativaDias: dias.toFixed(2), confiabilidade: 'Estimativa', inicioPrevisto: inicio }
    }))
    setMostrarEstimativaImportados(false)
  }

  const resumoImportados = useMemo(() => {
    let count = 0, totalPcs = 0
    for (const p of (novosPedidos || [])) {
      const qtd = parseFloat(p.quantidade) || 0
      const semProdMan = !p.produtividadeManual || parseFloat(p.produtividadeManual) <= 0
      const semHist = !p.confiabilidade || p.confiabilidade === 'Manual' || Number(p.estimativaHoras) <= 0
      if (qtd > 0 && semProdMan && semHist) { count++; totalPcs += qtd }
    }
    return { itens: count, totalPcs }
  }, [novosPedidos])

  // Seleção via checkboxes na tabela
  const isPedidoSelecionado = (pedidoSeq) => pedidosSelecionados.includes(pedidoSeq)
  const togglePedidoSelecionado = (pedidoSeq) => {
    setPedidosSelecionados(prev => {
      const set = new Set(prev)
      if (set.has(pedidoSeq)) set.delete(pedidoSeq)
      else set.add(pedidoSeq)
      return Array.from(set)
    })
  }
  const selecionarTodosVisiveis = () => {
    setPedidosSelecionados(Array.from(new Set((dadosFiltrados || []).map(p => p.pedido_seq))))
  }
  const limparSelecao = () => setPedidosSelecionados([])

  // Funções para gerenciar turnos
  const editarTurno = (turno) => {
    setTurnoEditando({ ...turno })
  }

  const salvarTurno = () => {
    if (!turnoEditando) return
    
    setTurnos(prev => prev.map(t => 
      t.id === turnoEditando.id ? turnoEditando : t
    ))
    setTurnoEditando(null)
    salvarTurnos()
  }

  const cancelarEdicaoTurno = () => {
    setTurnoEditando(null)
  }

  const toggleTurnoAtivo = (turnoId) => {
    setTurnos(prev => {
      const next = prev.map(t => (t.id === turnoId ? { ...t, ativo: !t.ativo } : t))
      salvarTurnos(next)
      return next
    })
  }

  const totalEstimativaHoras = itensParaCalculo.reduce((acc, item) => 
    acc + parseFloat(item.estimativaHoras || 0), 0
  )
  
  const totalEstimativaDias = totalEstimativaHoras / (horasUteisSelecionadas || 1)

  // Cálculo detalhado de término previsto considerando dias úteis e sábado (extras)
  const terminoDetalhado = useMemo(() => {
    try {
      const base = parseLocalDate(dataInicialPrevisao)
      if (isNaN(base.getTime())) return { data: '', diasUteis: 0, sabados: 0, domingos: 0, horasAcumuladas: 0 }
      const totalHoras = Number(totalEstimativaHoras || 0)
      if (!(totalHoras > 0)) {
        return { data: base.toLocaleDateString('pt-BR'), diasUteis: 0, sabados: 0, domingos: 0, horasAcumuladas: 0 }
      }
      let restante = Math.max(0, totalHoras)
      let cursor = new Date(base)
      let diasUteis = 0, sabados = 0, domingos = 0, horasAcumuladas = 0
      let guard = 0
      while (restante > 0 && guard < 3660) {
        const dow = cursor.getDay()
        let horasDia = 0
        if (dow >= 1 && dow <= 5) { horasDia = Number(horasUteisDiaUtil || 0); if (horasDia > 0) diasUteis++ }
        else if (dow === 6) { horasDia = Number(extrasSabado || 0); if (horasDia > 0) sabados++ }
        else { domingos++ }
        if (horasDia > 0) {
          restante -= horasDia
          horasAcumuladas += horasDia
        }
        if (restante <= 0) break
        cursor.setDate(cursor.getDate() + 1)
        guard++
      }
      const data = cursor.toLocaleDateString('pt-BR')
      return { data, diasUteis, sabados, domingos, horasAcumuladas }
    } catch { return { data: '', diasUteis: 0, sabados: 0, domingos: 0, horasAcumuladas: 0 } }
  }, [dataInicialPrevisao, totalEstimativaHoras, horasUteisDiaUtil, extrasSabado])

  // Gantt: calcular tarefas sequenciais a partir da data inicial selecionada (suporta frações de dia)
  const tarefasGantt = useMemo(() => {
    if (!itensParaCalculo || itensParaCalculo.length === 0) return []
    let itens = [...itensParaCalculo]
    if (ganttOrdenacao === 'prazo') {
      itens.sort((a, b) => {
        const da = a.dt_fatura ? new Date(a.dt_fatura).getTime() : Infinity
        const db = b.dt_fatura ? new Date(b.dt_fatura).getTime() : Infinity
        return da - db
      })
    } else if (ganttOrdenacao === 'estimativa') {
      itens.sort((a, b) => parseFloat(b.estimativaDias || 0) - parseFloat(a.estimativaDias || 0))
    } else if (ganttOrdenacao === 'comp_desc') {
      const getComp = (p) => {
        const dir = parseFloat(p.comprimentoMm)
        if (!isNaN(dir) && isFinite(dir)) return dir
        const str = extrairComprimentoAcabado(p.produto) || ''
        const num = parseFloat(String(str).replace(/[^0-9.]/g, ''))
        return isNaN(num) ? 0 : num
      }
      itens.sort((a, b) => getComp(b) - getComp(a))
    } else if (ganttOrdenacao === 'comp_asc') {
      const getComp = (p) => {
        const dir = parseFloat(p.comprimentoMm)
        if (!isNaN(dir) && isFinite(dir)) return dir
        const str = extrairComprimentoAcabado(p.produto) || ''
        const num = parseFloat(String(str).replace(/[^0-9.]/g, ''))
        return isNaN(num) ? 0 : num
      }
      itens.sort((a, b) => getComp(a) - getComp(b))
    } // 'sequencia' mantém ordem atual
    const inicioBase = parseLocalDate(dataInicialPrevisao)
    let cursorMs = inicioBase.getTime()
    let startIndex = 0 // em dias (pode ser fracionário)
    const tarefas = itens.map((p) => {
      const spanDias = Math.max(0, parseFloat(p.estimativaDias || 0)) // permite 0, mas trataremos exibição
      const inicio = new Date(cursorMs)
      const fim = new Date(cursorMs + spanDias * 24 * 60 * 60 * 1000)
      // Montagem do rótulo da tarefa: Pedido, Ferramenta, Comprimento
      const pedidoLbl = p.pedido_seq || p.id || ''
      const ferramentaLbl = extrairFerramenta(p.produto || p.ferramenta) || (p.ferramenta || '')
      const compLbl = p.comprimentoMm ? `${p.comprimentoMm} mm` : (extrairComprimentoAcabado(p.produto) || '')
      const tarefa = {
        id: p.pedido_seq || p.id,
        label: [pedidoLbl, ferramentaLbl, compLbl].filter(Boolean).join(' - '),
        produto: p.produto || p.ferramenta || '-',
        dias: spanDias,
        inicio,
        fim,
        startIndex,
        span: spanDias
      }
      // avançar cursor e índice (fracionário)
      cursorMs += spanDias * 24 * 60 * 60 * 1000
      startIndex += spanDias
      return tarefa
    })
    return tarefas
  }, [itensParaCalculo, dataInicialPrevisao, ganttOrdenacao])

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-800 mb-2">Previsão de Trabalho</h1>
        <p className="text-gray-600">Estimativas de tempo para conclusão de pedidos</p>
      </div>

      <div className="text-sm text-gray-600 mb-4">
        {terminoDetalhado.data && (
          <span>
            Contagem: {terminoDetalhado.diasUteis} dias úteis{extrasSabado > 0 ? ` + ${terminoDetalhado.sabados} sábado(s)` : ''} • {Number(horasUteisDiaUtil || 0).toFixed(2)}h/dia útil{extrasSabado > 0 ? ` • ${Number(extrasSabado || 0)}h/sábado` : ''}
          </span>
        )}
      </div>

      {/* Abas */}
      <div className="mb-6">
        <div className="border-b border-gray-200">
          <div className="overflow-x-auto">
          <nav className="-mb-px flex space-x-8 whitespace-nowrap">
            <button
              onClick={() => setAbaSelecionada('carteira')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                abaSelecionada === 'carteira'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <FaChartLine className="inline mr-2" />
              Carteira de Pedidos
            </button>
            <button
              onClick={() => setAbaSelecionada('manual')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                abaSelecionada === 'manual'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <FaCalculator className="inline mr-2" />
              Estimativa Manual
            </button>
            <button
              onClick={() => setAbaSelecionada('turnos')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                abaSelecionada === 'turnos'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <FaBusinessTime className="inline mr-2" />
              Turnos
            </button>
            <button
              onClick={() => setAbaSelecionada('produtividade')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                abaSelecionada === 'produtividade'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <FaClock className="inline mr-2" />
              Histórico Produtividade
            </button>
            <button
              onClick={() => setAbaSelecionada('gantt')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                abaSelecionada === 'gantt'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <FaProjectDiagram className="inline mr-2" />
              Gantt
            </button>
            <button
              onClick={() => setAbaSelecionada('fila')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                abaSelecionada === 'fila'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <FaList className="inline mr-2" />
              Fila de Produção
            </button>
            <button
              onClick={() => setAbaSelecionada('extrusao')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                abaSelecionada === 'extrusao'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <FaIndustry className="inline mr-2" />
              Calc. Extrusão
            </button>
          </nav>
          </div>
        </div>
      </div>

      {/* Filtros e resumo — ocultos na aba Calc. Extrusão */}
      {abaSelecionada !== 'extrusao' && (<>
        <div className="flex justify-end mb-2">
          <button onClick={() => setFiltrosExpandidos(v => !v)} className="text-sm px-3 py-1 rounded border border-gray-300 bg-white hover:bg-gray-50">
            {filtrosExpandidos ? 'Recolher filtros' : 'Expandir filtros'}
          </button>
        </div>
        <div className={`bg-white p-3 rounded-lg shadow mb-4 ${filtrosExpandidos ? '' : 'hidden'}`}>
        <div className="grid grid-cols-1 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <div className="min-w-0">
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Produto
            </label>
            <input
              type="text"
              name="produto"
              value={filtros.produto}
              onChange={handleFiltroChange}
              className="w-full h-9 px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
              placeholder="Filtrar por produto..."
            />
          </div>
          <div className="min-w-0">
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Pedido Cliente
            </label>
            <input
              type="text"
              value={filtroPedidoCliente}
              onChange={(e) => setFiltroPedidoCliente(e.target.value)}
              className="w-full h-9 px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
              placeholder="Filtrar por Pedido Cliente..."
            />
          </div>
          <div className="min-w-0">
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Data Inicial da Previsão
            </label>
            <input
              type="date"
              value={dataInicialPrevisao}
              onChange={(e) => setDataInicialPrevisao(e.target.value)}
              className="w-full h-9 px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div className="min-w-0">
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Tipo de Dia
            </label>
            <select
              value={tipoDia}
              onChange={(e) => setTipoDia(e.target.value)}
              className="w-full h-9 px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="dia_util">Dia Útil (turnos + extras)</option>
              <option value="sabado">Sábado (apenas extras de sábado)</option>
            </select>
          </div>
          <div className="min-w-0">
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Horas Úteis Selecionadas
            </label>
            <input
              type="text"
              value={`${Number(horasUteisSelecionadas || 0).toFixed(2)}h`}
              readOnly
              className="w-full h-9 px-2 py-1.5 text-sm border border-gray-300 rounded-md bg-gray-100 text-gray-600"
            />
          </div>
          <div className="min-w-0">
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Turnos Ativos
            </label>
            <input
              type="text"
              value={turnos.filter(t => t.ativo).map(t => t.id).join(', ')}
              readOnly
              className="w-full h-9 px-2 py-1.5 text-sm border border-gray-300 rounded-md bg-gray-100 text-gray-600"
            />
          </div>
        </div>
        
        {/* Configuração de Produtividade */}
        <div className="bg-blue-50 p-4 rounded-lg mt-4">
          <h4 className="text-sm font-medium text-gray-800 mb-3">Modo de Cálculo de Produtividade</h4>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Método de Cálculo
              </label>
              <select
                value={modoProdutividade}
                onChange={(e) => {
                  const novoModo = e.target.value
                  setModoProdutividade(novoModo)
                  salvarConfigProdutividade(novoModo, undefined)
                }}
                className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="historica">Produtividade Histórica (Registrada)</option>
                <option value="estimativa">Estimativa Manual (Peças/Dia)</option>
              </select>
            </div>
            {modoProdutividade === 'estimativa' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Estimativa (peças/dia)
                </label>
                <input
                  type="number"
                  value={estimativaPcsPorDia}
                  onChange={(e) => {
                    const novoValor = parseInt(e.target.value) || 20000
                    setEstimativaPcsPorDia(novoValor)
                    salvarConfigProdutividade(undefined, novoValor)
                  }}
                  className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                  placeholder="20000"
                />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Filtro</label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={apenasSaldoPositivo} onChange={(e)=>setApenasSaldoPositivo(e.target.checked)} />
                Apenas com saldo {'>'}= 0 ({resumoCarteiraSaldo.saldoPos}/{resumoCarteiraSaldo.total})
              </label>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Status</label>
              <div className="p-2 bg-white border border-gray-300 rounded-md text-sm text-gray-600">
                {modoProdutividade === 'historica' ? 
                  'Usando dados de apontamentos' : 
                  `${estimativaPcsPorDia.toLocaleString('pt-BR')} pcs/dia`
                }
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Seleção de Pedidos removida (uso de checkboxes na tabela) */}

      {/* Resumo */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-blue-50 p-4 rounded-lg">
          <div className="flex items-center">
            <FaClock className="text-blue-600 text-2xl mr-3" />
            <div>
              <p className="text-sm text-gray-600">Total Estimado</p>
              <p className="text-2xl font-bold text-blue-600">
                {totalEstimativaHoras.toFixed(2)}h
              </p>
            </div>
          </div>
        </div>
        <div className="bg-green-50 p-4 rounded-lg">
          <div className="flex items-center">
            <FaChartLine className="text-green-600 text-2xl mr-3" />
            <div>
              <p className="text-sm text-gray-600">Dias de Trabalho</p>
              <p className="text-2xl font-bold text-green-600">
                {totalEstimativaDias.toFixed(2)} dias
              </p>
            </div>
          </div>
        </div>
        <div className="bg-indigo-50 p-4 rounded-lg">
          <div className="flex items-center">
            <FaBusinessTime className="text-indigo-600 text-2xl mr-3" />
            <div>
              <p className="text-sm text-gray-600">Término Previsto</p>
              <p className="text-2xl font-bold text-indigo-600">
                {terminoDetalhado.data || '-'}
              </p>
            </div>
          </div>
        </div>
        <div className="bg-yellow-50 p-4 rounded-lg">
          <div className="flex items-center">
            <FaCalculator className="text-yellow-600 text-2xl mr-3" />
            <div>
              <p className="text-sm text-gray-600">Itens</p>
              <p className="text-2xl font-bold text-yellow-600">
                {itensParaCalculo.length}
              </p>
            </div>
          </div>
        </div>
      </div>
      </>)}

      {/* Aba: Gantt (renderização independente) */}
      {abaSelecionada === 'gantt' && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-lg font-medium text-gray-900">Gantt da Previsão</h3>
            <p className="text-sm text-gray-600">Início: {parseLocalDate(dataInicialPrevisao).toLocaleDateString('pt-BR')} • Término previsto: {terminoDetalhado.data || '-'}</p>
          </div>
          <div className="p-4 overflow-x-auto">
            {/* Controles Gantt */}
            <div className="flex flex-wrap items-center gap-4 mb-4">
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-700">Zoom</label>
                <input type="range" min="20" max="80" step="4" value={ganttZoomPX} onChange={(e)=>setGanttZoomPX(parseInt(e.target.value)||36)} />
                <span className="text-sm text-gray-500">{ganttZoomPX}px/dia</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-700">Ordenar por</label>
                <select value={ganttOrdenacao} onChange={(e)=>setGanttOrdenacao(e.target.value)} className="p-1 border border-gray-300 rounded">
                  <option value="prazo">Prazo (dt_fatura)</option>
                  <option value="estimativa">Maior duração</option>
                  <option value="comprimento">Comprimento</option>
                  <option value="sequencia">Sequência atual</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={ganttSombrarFds} onChange={(e)=>setGanttSombrarFds(e.target.checked)} /> Sombrar finais de semana
              </label>
            </div>
            {tarefasGantt.length === 0 ? (
              <p className="text-gray-500">Nenhum item para exibir.</p>
            ) : (
              (() => {
                const totalSpan = tarefasGantt.reduce((acc, t) => acc + (parseFloat(t.span) || 0), 0)
                const diasTotais = Math.max(1, Math.ceil(totalSpan))
                const diaLargura = ganttZoomPX // px por dia
                const headers = Array.from({ length: diasTotais }, (_, i) => {
                  const d = parseLocalDate(dataInicialPrevisao)
                  d.setDate(d.getDate() + i)
                  return d
                })
                // Header de meses
                const meses = []
                let i = 0
                while (i < diasTotais) {
                  const d = headers[i]
                  const mes = d.getMonth()
                  let span = 0
                  while (i + span < diasTotais && headers[i + span].getMonth() === mes) span++
                  meses.push({ label: d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }), span })
                  i += span
                }

                const hoje = new Date()
                const idxHoje = Math.floor((hoje - parseLocalDate(dataInicialPrevisao)) / (1000 * 60 * 60 * 24))

                return (
                  <div>
                    {/* Header de meses */}
                    <div className="grid" style={{ gridTemplateColumns: `220px repeat(${diasTotais}, ${diaLargura}px)` }}>
                      <div></div>
                      {meses.map((m, idx) => (
                        <div key={idx} className="text-xs text-center text-gray-700 font-medium border-b border-gray-200 flex items-center justify-center" style={{ gridColumn: `span ${m.span}` }}>
                          {m.label.toUpperCase()}
                        </div>
                      ))}
                    </div>
                    {/* Header de dias */}
                    <div className="grid" style={{ gridTemplateColumns: `220px repeat(${diasTotais}, ${diaLargura}px)` }}>
                      <div className="text-xs text-gray-400 pl-2">Tarefa</div>
                      {headers.map((d, idx) => (
                        <div key={idx} className={`text-[10px] text-center border-r border-gray-100 ${ganttSombrarFds && (d.getDay()===0 || d.getDay()===6) ? 'bg-gray-50 text-gray-400' : 'text-gray-400'}`}>
                          {d.getDate().toString().padStart(2, '0')}
                        </div>
                      ))}
                    </div>

                    {/* Grade + barras */}
                    <div className="relative">
                      {/* Marcador de hoje */}
                      {idxHoje >= 0 && idxHoje < diasTotais && (
                        <div className="absolute top-0 bottom-0 w-0.5 bg-red-500" style={{ left: `${220 + idxHoje * diaLargura}px` }}></div>
                      )}
                      {tarefasGantt.map((t) => {
                        // Buscar confiabilidade do item original
                        const itemOriginal = itensParaCalculo.find(item => (item.pedido_seq || item.id) === t.id)
                        const confiabilidade = itemOriginal?.confiabilidade || 'Baixa'
                        const cor = confiabilidade === 'Alta' ? 'bg-green-500' : 
                                   confiabilidade === 'Média' ? 'bg-yellow-500' : 
                                   confiabilidade === 'Estimativa' ? 'bg-purple-500' : 'bg-blue-500'
                        return (
                          <div key={t.id} className="grid items-center" style={{ gridTemplateColumns: `220px repeat(${diasTotais}, ${diaLargura}px)` }}>
                            <div className="text-sm text-gray-700 py-2 pr-3 truncate">{t.label}</div>
                            {headers.map((d, i) => (
                              <div key={i} className={`h-7 border-b border-r border-gray-100 ${ganttSombrarFds && (d.getDay()===0 || d.getDay()===6) ? 'bg-gray-50' : ''}`}></div>
                            ))}
                            {/* Barra posicionada por grid */}
                            <div className="col-start-2 col-end-[-1] -mt-7 relative" style={{ pointerEvents: 'none' }}>
                              <div className={`h-7 ${cor} rounded shadow-sm text-white text-[11px] flex items-center justify-center`}
                                   title={`${t.label} | ${t.inicio.toLocaleDateString('pt-BR')} → ${t.fim.toLocaleDateString('pt-BR')} | ${Number(t.span || 0).toFixed(2)} dia(s) | ${confiabilidade}`}
                                   style={{ position: 'absolute', left: `${t.startIndex * diaLargura}px`, width: `${Math.max(0.05, t.span) * diaLargura}px`, minWidth: '4px' }}>
                                {Number(t.span) < 1 ? `${(Number(t.span)*24).toFixed(1)}h` : `${Number(t.span).toFixed(1)}d`}
                              </div>
                              <div className="text-[10px] text-gray-500 mt-1" style={{ position: 'absolute', left: `${t.startIndex * diaLargura}px`, top: '28px' }}>
                                {t.inicio.toLocaleDateString('pt-BR')} → {t.fim.toLocaleDateString('pt-BR')}
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })()
            )}
          </div>
        </div>
      )}

      {/* Conteúdo das Abas */}
      {abaSelecionada === 'fila' && (
        <div className="space-y-4">
          <div className="bg-white p-4 rounded-lg shadow">
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Cenário</label>
                <select value={filaCenario} onChange={(e)=>setFilaCenario(e.target.value)} className="p-2 border border-gray-300 rounded-md">
                  <option value="atual">Atual</option>
                  <option value="sim1">Simulação 1</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Visualizar por</label>
                <select
                  value={filaAgruparPor}
                  onChange={(e) => {
                    const v = e.target.value
                    setFilaAgruparPor(v)
                    salvarFilaAgruparPor(v)
                  }}
                  className="p-2 border border-gray-300 rounded-md"
                >
                  <option value="cliente">Cliente</option>
                  <option value="pedido_cliente">Pedido Cliente</option>
                  <option value="pedido_seq">Pedido/Seq</option>
                </select>
              </div>
              <div className="flex-1"></div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={filaOrdenarPorDtFatura}
                  className="px-3 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
                  disabled={filaItensOrdenados.length === 0}
                  title="Ordena a sequência do cenário selecionado pela Dt.Fatura (mais cedo primeiro)"
                >
                  Ordenar por Dt.Fatura
                </button>
                <button
                  onClick={() => setMostrarModalExportarFila(true)}
                  className="px-3 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
                  disabled={filaItensOrdenados.length === 0}
                >
                  Exportar Excel
                </button>
                <button
                  onClick={filaCriarSimulacao}
                  className="px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                  disabled={!filaBaseIdsDefault.length}
                >
                  Criar simulação
                </button>
                <button
                  onClick={filaAplicarSimulacao}
                  className="px-3 py-2 bg-green-600 text-white rounded hover:bg-green-700"
                  disabled={filaSim1Ids.length === 0}
                >
                  Aplicar simulação
                </button>
                <button
                  onClick={filaDescartarSimulacao}
                  className="px-3 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
                  disabled={filaSim1Ids.length === 0}
                >
                  Descartar
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-medium text-gray-900">Fila de Produção (arraste para reordenar)</h3>
              <p className="text-sm text-gray-600">Fila única considerando 1 operador</p>
            </div>
            <div className="p-4">
              {filaGrupos.length === 0 ? (
                <p className="text-gray-500">Nenhum item para exibir.</p>
              ) : (
                <div className="space-y-4">
                  {filaGrupos.map((g) => {
                    const keyStr = String(g.key)
                    const recolhido = (filaAgruparPor === 'cliente' || filaAgruparPor === 'pedido_cliente')
                      ? (filaGruposRecolhidos?.[filaAgruparPor] || []).map(String).includes(keyStr)
                      : false
                    const horasGrupo = (g.items || []).reduce((acc, p) => acc + (parseFloat(p.estimativaHoras) || 0), 0)
                    const saldoGrupo = (g.items || []).reduce((acc, p) => acc + (parseFloat(p.saldoProduzir) || 0), 0)
                    const grupoPodeArrastar = filaAgruparPor === 'cliente' || filaAgruparPor === 'pedido_cliente'
                    const clienteDoGrupo = String((g.items?.[0]?.cliente || g.items?.[0]?.nome_cliente || 'Sem Cliente') || 'Sem Cliente')
                    const dtFaturaMin = (() => {
                      const dates = (g.items || [])
                        .map(it => it?.dt_fatura)
                        .filter(Boolean)
                        .map(v => new Date(v))
                        .filter(d => !Number.isNaN(d.getTime()))
                      if (!dates.length) return ''
                      dates.sort((a, b) => a.getTime() - b.getTime())
                      return dates[0].toLocaleDateString('pt-BR')
                    })()
                    const tituloGrupo = filaAgruparPor === 'pedido_cliente'
                      ? `${String(g.key)} — ${dtFaturaMin ? `${dtFaturaMin} • ` : ''}${clienteDoGrupo}`
                      : String(g.key)
                    return (
                      <div key={g.key} className="border border-gray-200 rounded-lg overflow-hidden">
                        <button
                          type="button"
                          onClick={() => {
                            if (filaArrastandoGrupoRef.current) return
                            filaToggleGrupo(g.key)
                          }}
                          draggable={grupoPodeArrastar}
                          onDragStart={(e) => filaGrupoOnDragStart(e, g.key)}
                          onDragEnd={filaGrupoOnDragEnd}
                          onDragOver={filaAllowDrop}
                          onDrop={(e) => filaGrupoOnDrop(e, g.key)}
                          className="w-full bg-gray-50 px-4 py-2 text-sm font-medium text-gray-700 flex items-center justify-between"
                          disabled={filaAgruparPor === 'pedido_seq'}
                          title={filaAgruparPor === 'pedido_seq' ? 'Agrupamento por Pedido/Seq não possui recolher/expandir' : 'Clique para recolher/expandir (ou arraste para reordenar)'}
                        >
                          <span className="truncate">{tituloGrupo}</span>
                          <span className="text-xs text-gray-500">{recolhido ? 'Expandir' : 'Recolher'} • Saldo: {Number(saldoGrupo || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} • {Number(horasGrupo || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}h • {g.items.length} item(ns)</span>
                        </button>
                        {!recolhido && (
                          <div className="p-3 space-y-2">
                            {g.items.map((p, idxItem) => {
                              const id = String(p.pedido_seq)
                              const saldo = Number(p.saldoProduzir || 0)
                              const horas = Number(p.estimativaHoras || 0)
                              const confiabilidade = p.confiabilidade || '-'
                              const carteira = p.carteira
                              const carteiraItemPerfil = p.carteiraItemPerfil
                              const carteiraFerramenta = p.carteiraFerramenta
                              return (
                                <div
                                  key={`${id}-${idxItem}`}
                                  draggable
                                  onDragStart={(e) => filaOnDragStart(e, id)}
                                  onDragOver={filaAllowDrop}
                                  onDrop={(e) => filaOnDrop(e, id)}
                                  className="border border-gray-200 rounded-md p-3 bg-white hover:bg-gray-50 cursor-move"
                                  title="Arraste para mudar a sequência"
                                >
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0 flex-1">
                                      <div className="text-sm font-semibold text-gray-900 truncate">{p.pedido_seq}</div>
                                      <div className="text-xs text-gray-600 truncate">{p.pedido_cliente || p.cliente || '-'}</div>
                                      <div className="text-xs text-gray-500 truncate">{p.produto || '-'}</div>
                                      {carteira && (
                                        <div className="mt-2 pt-2 border-t border-gray-200 text-xs text-gray-600 space-y-1">
                                          <div className="font-semibold text-gray-700">Por Nr Pedido:</div>
                                          <div><strong>Pedido:</strong> {carteira.pedido || '-'}</div>
                                          <div className="grid grid-cols-2 gap-2">
                                            <div><strong>Pedido Kg:</strong> {Number(carteira.pedido_kg || 0).toLocaleString('pt-BR')}</div>
                                            <div><strong>Pedido Pc:</strong> {Number(carteira.pedido_pc || 0).toLocaleString('pt-BR')}</div>
                                            <div><strong>Produzido Kg:</strong> {Number(carteira.produzido_kg || 0).toLocaleString('pt-BR')}</div>
                                            <div><strong>Produzido Pc:</strong> {Number(carteira.produzido_pc || 0).toLocaleString('pt-BR')}</div>
                                            <div><strong>Embalado Kg:</strong> {Number(carteira.embalado_kg || 0).toLocaleString('pt-BR')}</div>
                                            <div><strong>Embalado Pc:</strong> {Number(carteira.embalado_pc || 0).toLocaleString('pt-BR')}</div>
                                          </div>
                                        </div>
                                      )}
                                      {carteiraItemPerfil && (
                                        <div className="mt-2 pt-2 border-t border-gray-200 text-xs text-gray-600 space-y-1">
                                          <div className="font-semibold text-gray-700">Por Produto (Item.Perfil):</div>
                                          <div><strong>Pedido:</strong> {carteiraItemPerfil.pedido || '-'}</div>
                                          <div><strong>Nr Pedido:</strong> {carteiraItemPerfil.nr_pedido || '-'}</div>
                                          <div><strong>Ferramenta:</strong> {carteiraItemPerfil.ferramenta || '-'}</div>
                                          <div className="grid grid-cols-2 gap-2">
                                            <div><strong>Pedido Kg:</strong> {Number(carteiraItemPerfil.pedido_kg || 0).toLocaleString('pt-BR')}</div>
                                            <div><strong>Pedido Pc:</strong> {Number(carteiraItemPerfil.pedido_pc || 0).toLocaleString('pt-BR')}</div>
                                            <div><strong>Produzido Kg:</strong> {Number(carteiraItemPerfil.produzido_kg || 0).toLocaleString('pt-BR')}</div>
                                            <div><strong>Produzido Pc:</strong> {Number(carteiraItemPerfil.produzido_pc || 0).toLocaleString('pt-BR')}</div>
                                            <div><strong>Embalado Kg:</strong> {Number(carteiraItemPerfil.embalado_kg || 0).toLocaleString('pt-BR')}</div>
                                            <div><strong>Embalado Pc:</strong> {Number(carteiraItemPerfil.embalado_pc || 0).toLocaleString('pt-BR')}</div>
                                          </div>
                                        </div>
                                      )}
                                      {carteiraFerramenta && (
                                        <div className="mt-2 pt-2 border-t border-gray-200 text-xs text-gray-600 space-y-1">
                                          <div className="font-semibold text-gray-700">Por Ferramenta (Extrusão):</div>
                                          <div><strong>Pedido:</strong> {carteiraFerramenta.pedido || '-'}</div>
                                          <div><strong>Nr Pedido:</strong> {carteiraFerramenta.nr_pedido || '-'}</div>
                                          <div><strong>Produto:</strong> {carteiraFerramenta.produto || '-'}</div>
                                          <div className="grid grid-cols-2 gap-2">
                                            <div><strong>Pedido Kg:</strong> {Number(carteiraFerramenta.pedido_kg || 0).toLocaleString('pt-BR')}</div>
                                            <div><strong>Pedido Pc:</strong> {Number(carteiraFerramenta.pedido_pc || 0).toLocaleString('pt-BR')}</div>
                                            <div><strong>Produzido Kg:</strong> {Number(carteiraFerramenta.produzido_kg || 0).toLocaleString('pt-BR')}</div>
                                            <div><strong>Produzido Pc:</strong> {Number(carteiraFerramenta.produzido_pc || 0).toLocaleString('pt-BR')}</div>
                                            <div><strong>Embalado Kg:</strong> {Number(carteiraFerramenta.embalado_kg || 0).toLocaleString('pt-BR')}</div>
                                            <div><strong>Embalado Pc:</strong> {Number(carteiraFerramenta.embalado_pc || 0).toLocaleString('pt-BR')}</div>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                    <div className="flex flex-col items-end gap-1">
                                      <div className="text-xs text-gray-700">Saldo: {saldo.toLocaleString('pt-BR')}</div>
                                      <div className="text-xs text-gray-700">{horas.toFixed(2)}h</div>
                                      <div className="text-xs text-gray-500">{confiabilidade}</div>
                                    </div>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {abaSelecionada === 'carteira' && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-lg font-medium text-gray-900">
              Estimativa para Pedidos da Carteira
            </h3>
            <div className="mt-3 flex items-center gap-2">
              <button onClick={selecionarTodosVisiveis} className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700">Selecionar todos</button>
              <button onClick={limparSelecao} className="px-3 py-1 bg-gray-200 text-gray-800 rounded hover:bg-gray-300">Limpar seleção</button>
              {pedidosSelecionados.length > 0 && (
                <span className="text-sm text-gray-600">{pedidosSelecionados.length} selecionados</span>
              )}

      {abaSelecionada === 'gantt' && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-lg font-medium text-gray-900">Gantt da Previsão</h3>
            <p className="text-sm text-gray-600">Início: {parseLocalDate(dataInicialPrevisao).toLocaleDateString('pt-BR')} • Término previsto: {terminoDetalhado.data || '-'}</p>
          </div>
          <div className="p-4 overflow-x-auto">
            {/* Controles Gantt */}
            <div className="flex flex-wrap items-center gap-4 mb-4">
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-700">Zoom</label>
                <input type="range" min="20" max="80" step="4" value={ganttZoomPX} onChange={(e)=>setGanttZoomPX(parseInt(e.target.value)||36)} />
                <span className="text-sm text-gray-500">{ganttZoomPX}px/dia</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-700">Ordenar por</label>
                <select value={ganttOrdenacao} onChange={(e)=>setGanttOrdenacao(e.target.value)} className="p-1 border border-gray-300 rounded">
                  <option value="prazo">Prazo (dt_fatura)</option>
                  <option value="estimativa">Maior duração</option>
                  <option value="comp_asc">Comprimento de AZ (menor → maior)</option>
                  <option value="comp_desc">Comprimento de ZA (maior → menor)</option>
                  <option value="sequencia">Sequência atual</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={ganttSombrarFds} onChange={(e)=>setGanttSombrarFds(e.target.checked)} /> Sombrar finais de semana
              </label>
            </div>
            {tarefasGantt.length === 0 ? (
              <p className="text-gray-500">Nenhum item para exibir.</p>
            ) : (
              (() => {
                const diasTotais = Math.max(1, tarefasGantt.reduce((acc, t) => acc + t.span, 0))
                const diaLargura = ganttZoomPX // px por dia
                const headers = Array.from({ length: diasTotais }, (_, i) => {
                  const d = parseLocalDate(dataInicialPrevisao)
                  d.setDate(d.getDate() + i)
                  return d
                })
                // Header de meses
                const meses = []
                let i = 0
                while (i < diasTotais) {
                  const d = headers[i]
                  const mes = d.getMonth()
                  let span = 0
                  while (i + span < diasTotais && headers[i + span].getMonth() === mes) span++
                  meses.push({ label: d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }), span })
                  i += span
                }

                const hoje = new Date()
                const idxHoje = Math.floor((hoje - parseLocalDate(dataInicialPrevisao)) / (1000 * 60 * 60 * 24))

                return (
                  <div>
                    {/* Header de meses */}
                    <div className="grid" style={{ gridTemplateColumns: `220px repeat(${diasTotais}, ${diaLargura}px)` }}>
                      <div></div>
                      {meses.map((m, idx) => (
                        <div key={idx} className="text-xs text-center text-gray-700 font-medium border-b border-gray-200 flex items-center justify-center" style={{ gridColumn: `span ${m.span}` }}>
                          {m.label.toUpperCase()}
                        </div>
                      ))}
                    </div>
                    {/* Header de dias */}
                    <div className="grid" style={{ gridTemplateColumns: `220px repeat(${diasTotais}, ${diaLargura}px)` }}>
                      <div className="text-xs text-gray-400 pl-2">Tarefa</div>
                      {headers.map((d, idx) => (
                        <div key={idx} className={`text-[10px] text-center border-r border-gray-100 ${ganttSombrarFds && (d.getDay()===0 || d.getDay()===6) ? 'bg-gray-50 text-gray-400' : 'text-gray-400'}`}>
                          {d.getDate().toString().padStart(2, '0')}
                        </div>
                      ))}
                    </div>

                    {/* Grade + barras */}
                    <div className="relative">
                      {/* Marcador de hoje */}
                      {idxHoje >= 0 && idxHoje < diasTotais && (
                        <div className="absolute top-0 bottom-0 w-0.5 bg-red-500" style={{ left: `${220 + idxHoje * diaLargura}px` }}></div>
                      )}
                      {tarefasGantt.map((t) => {
                        const cor = t.confiabilidade === 'Alta' ? 'bg-green-500' : t.confiabilidade === 'Média' ? 'bg-yellow-500' : 'bg-blue-500'
                        return (
                          <div key={t.id} className="grid items-center" style={{ gridTemplateColumns: `220px repeat(${diasTotais}, ${diaLargura}px)` }}>
                            <div className="text-sm text-gray-700 py-2 pr-3 truncate">{t.label}</div>
                            {headers.map((d, i) => (
                              <div key={i} className={`h-7 border-b border-r border-gray-100 ${ganttSombrarFds && (d.getDay()===0 || d.getDay()===6) ? 'bg-gray-50' : ''}`}></div>
                            ))}
                            {/* Barra posicionada por grid */}
                            <div className="col-start-2 col-end-[-1] -mt-7 relative" style={{ pointerEvents: 'none' }}>
                              <div className={`h-7 ${cor} rounded shadow-sm text-white text-xs flex items-center justify-center`}
                                   title={`${t.label} | ${t.inicio.toLocaleDateString('pt-BR')} → ${t.fim.toLocaleDateString('pt-BR')} | ${t.span} dia(s)`}
                                   style={{ position: 'absolute', left: `${t.startIndex * diaLargura}px`, width: `${t.span * diaLargura}px` }}>
                                {t.span}d
                              </div>
                              <div className="text-[10px] text-gray-500 mt-1" style={{ position: 'absolute', left: `${t.startIndex * diaLargura}px`, top: '28px' }}>
                                {t.inicio.toLocaleDateString('pt-BR')} → {t.fim.toLocaleDateString('pt-BR')}
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })()
            )}
          </div>
        </div>
      )}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3">
                    <input
                      type="checkbox"
                      onChange={(e) => e.target.checked ? selecionarTodosVisiveis() : limparSelecao()}
                      checked={pedidosSelecionados.length > 0 && (dadosFiltrados || []).every(p => pedidosSelecionados.includes(p.pedido_seq))}
                      className="h-4 w-4 text-blue-600 border-gray-300 rounded"
                      title="Selecionar todos"
                    />
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Pedido/Seq
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Pedido Cliente
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Produto
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Saldo a Produzir
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Produtividade (pcs/h)
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Teórico (pcs/h)
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Estimativa (horas)
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Estimativa (dias)
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Confiabilidade
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Prazo
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {dadosFiltrados.map((pedido, index) => (
                  <tr key={index} className="hover:bg-gray-50">
                    <td className="px-4 py-4 whitespace-nowrap">
                      <input
                        type="checkbox"
                        checked={isPedidoSelecionado(pedido.pedido_seq)}
                        onChange={() => togglePedidoSelecionado(pedido.pedido_seq)}
                        className="h-4 w-4 text-blue-600 border-gray-300 rounded"
                      />
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {pedido.pedido_seq}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {pedido.pedido_cliente || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {pedido.produto}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {pedido.saldoProduzir?.toLocaleString('pt-BR')}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {pedido.produtividade ? pedido.produtividade.pcsPorHora.toFixed(1) : '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {pedido.teoricoPcsHora ? Number(pedido.teoricoPcsHora).toFixed(1) : '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {pedido.estimativaHoras}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {pedido.estimativaDias}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                        pedido.confiabilidade === 'Alta' ? 'bg-green-100 text-green-800' :
                        pedido.confiabilidade === 'Média' ? 'bg-yellow-100 text-yellow-800' :
                        'bg-red-100 text-red-800'
                      }`}>
                        {pedido.confiabilidade}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {pedido.dt_fatura ? new Date(pedido.dt_fatura).toLocaleDateString('pt-BR') : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal Importar Cotação */}
      {mostrarCotacao && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6">
            <h4 className="text-lg font-semibold text-gray-900 mb-2">Importar Formulário de Cotação</h4>
            <p className="text-sm text-gray-600 mb-4">Carregue um arquivo CSV/XLSX com as colunas: produto, descricao, quantidade, produtividade, ferramenta, comprimento_mm.</p>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={async (e) => {
              const file = e.target.files?.[0]
              await importarCotacaoArquivo(file)
            }} className="w-full mb-4" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setMostrarCotacao(false)} className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300">Fechar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Estimativa para Importados */}
      {mostrarEstimativaImportados && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h4 className="text-lg font-semibold text-gray-900 mb-2">Estimativa (peças/dia) para Importados</h4>
            <p className="text-sm text-gray-600 mb-3">Defina uma taxa de produção diária para calcular horas e dias dos itens importados sem produtividade histórica.</p>
            <label className="block text-sm font-medium text-gray-700 mb-2">Estimativa (pcs/dia)</label>
            <input type="number" value={estimativaPcsDiaImportados} onChange={(e)=>setEstimativaPcsDiaImportados(parseInt(e.target.value)||0)} className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 mb-4" />
            <div className="bg-gray-50 border border-gray-200 rounded-md p-3 text-sm text-gray-700 mb-4">
              <div className="mb-1">Quantidade de Itens no pedido: <b>{resumoImportados.itens}</b></div>
              <div className="mb-3">Quantidade de Pcs para Recortar: <b>{resumoImportados.totalPcs.toLocaleString('pt-BR')}</b></div>
              <div className="mb-2 font-medium">Data de início</div>
              <label className="flex items-center gap-2 mb-2">
                <input type="radio" name="inicioImp" value="carteira" checked={dataInicioImportadosModo==='carteira'} onChange={()=>setDataInicioImportadosModo('carteira')} />
                <span>Usar "Término Previsto" da Carteira: <b>{terminoDetalhado?.data || '-'}</b></span>
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="inicioImp" value="manual" checked={dataInicioImportadosModo==='manual'} onChange={()=>setDataInicioImportadosModo('manual')} />
                <span>Informar manualmente:</span>
              </label>
              {dataInicioImportadosModo==='manual' && (
                <div className="mt-2">
                  <input type="date" value={dataInicioImportados} onChange={(e)=>setDataInicioImportados(e.target.value)} className="p-2 border border-gray-300 rounded-md" />
                </div>
              )}
              <div className="mt-3">Estimativa (peças/dia) informada: <b>{Number(estimativaPcsDiaImportados||0).toLocaleString('pt-BR')}</b></div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={()=>setMostrarEstimativaImportados(false)} className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300">Cancelar</button>
              <button onClick={aplicarEstimativaImportados} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">Aplicar</button>
            </div>
          </div>
        </div>
      )}

      {abaSelecionada === 'manual' && (
        <div className="space-y-6">
          {/* Ações e formulário para adicionar/ajustar estimativas manuais */}
          <div className="bg-white p-6 rounded-lg shadow">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Adicionar Estimativa Manual</h3>
            <div className="flex flex-wrap gap-2 mb-4">
              <button onClick={()=>setMostrarFormManual(v=>!v)} className="bg-blue-600 text-white px-3 py-2 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <FaPlus className="inline mr-2" /> {mostrarFormManual ? 'Fechar formulário' : 'Abrir formulário manual'}
              </button>
              <button onClick={()=>{
                const hoje = new Date(); const y = hoje.getFullYear(); const m = String(hoje.getMonth()+1).padStart(2,'0'); const d = String(hoje.getDate()).padStart(2,'0')
                const ymdHoje = `${y}-${m}-${d}`
                const ymdPrev = ptBrToYMD(terminoDetalhado?.data)
                setDataInicioImportadosModo('carteira')
                setDataInicioImportados(ymdPrev || ymdHoje)
                setMostrarEstimativaImportados(true)
              }} className="bg-purple-600 text-white px-3 py-2 rounded-md hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-500">
                Definir Estimativa (pcs/dia) para Importados
              </button>
              <button onClick={() => setMostrarCotacao(true)} className="bg-indigo-600 text-white px-3 py-2 rounded-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500" title="Importar formulário de cotação">
                <FaFileImport className="inline mr-2" /> Importar Cotação
              </button>
              <button onClick={limparNovosPedidos} className="bg-red-600 text-white px-3 py-2 rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500" title="Remover todas as estimativas manuais">
                <FaTrash className="inline mr-2" /> Limpar Lista
              </button>
            </div>
            {mostrarFormManual && (
              <div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Ferramenta</label>
                    <input type="text" value={novoPedido.ferramenta} onChange={(e) => setNovoPedido(prev => ({ ...prev, ferramenta: e.target.value }))} className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500" placeholder="Ex.: TR-0018" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Comprimento (mm)</label>
                    <input type="number" step="1" value={novoPedido.comprimentoMm} onChange={(e) => setNovoPedido(prev => ({ ...prev, comprimentoMm: e.target.value }))} className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500" placeholder="Ex.: 1100" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Volume (pcs)</label>
                    <input type="number" value={novoPedido.quantidade} onChange={(e) => setNovoPedido(prev => ({ ...prev, quantidade: e.target.value }))} className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500" placeholder="Qtd a produzir (pcs)" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Produtividade (pcs/h)</label>
                    <input type="number" step="0.1" value={novoPedido.produtividadeManual} onChange={(e) => setNovoPedido(prev => ({ ...prev, produtividadeManual: e.target.value }))} className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500" placeholder="Opcional" />
                  </div>
                </div>
                <button onClick={adicionarNovoPedido} className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <FaPlus className="inline mr-2" /> Adicionar
                </button>
              </div>
            )}
          </div>

          {/* Lista de estimativas manuais */}
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-medium text-gray-900">
                Estimativas Manuais
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Ferramenta
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Comprimento (mm)
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Volume (pcs)
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Produtividade (pcs/h)
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Estimativa (horas)
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Estimativa (dias)
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Confiabilidade
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Ações
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {novosPedidos.map((pedido) => (
                    <tr key={pedido.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {pedido.ferramenta || '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {pedido.comprimentoMm || '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {pedido.quantidade?.toLocaleString('pt-BR')}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {pedido.produtividadeManual ? Number(pedido.produtividadeManual).toFixed(1) : '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {pedido.estimativaHoras}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {pedido.estimativaDias}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                          pedido.confiabilidade === 'Manual' ? 'bg-blue-100 text-blue-800' :
                          'bg-green-100 text-green-800'
                        }`}>
                          {pedido.confiabilidade}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        <button
                          onClick={() => removerNovoPedido(pedido.id)}
                          className="text-red-600 hover:text-red-900"
                        >
                          <FaTrash />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {abaSelecionada === 'produtividade' && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-lg font-medium text-gray-900">
              Histórico de Produtividade por Produto
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Produto
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Registros
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Total Produzido
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Total Horas
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Pcs/Hora
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Pcs/Dia (8h)
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Máquinas
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Operadores
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {Object.values(produtividadePorProduto).map((stat, index) => (
                  <tr key={index} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {stat.produto}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {stat.registros}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {stat.totalPcs.toLocaleString('pt-BR')}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {stat.totalHoras.toFixed(1)}h
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {stat.pcsPorHora.toFixed(1)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {stat.pcsPorDia.toFixed(1)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {stat.maquinasArray.join(', ')}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {stat.operadoresArray.join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {abaSelecionada === 'turnos' && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-lg font-medium text-gray-900">
              Configuração de Turnos de Trabalho
            </h3>
            <p className="text-sm text-gray-600 mt-1">
              Configure os turnos para cálculos mais precisos de estimativas
            </p>
          </div>
          <div className="p-6">
            <div className="grid grid-cols-1 gap-4">
              {turnos.map((turno) => (
                <div key={turno.id} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        checked={turno.ativo}
                        onChange={() => toggleTurnoAtivo(turno.id)}
                        className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded mr-3"
                      />
                      <h4 className={`text-lg font-medium ${turno.ativo ? 'text-gray-900' : 'text-gray-400'}`}>
                        {turno.nome} ({turno.id})
                      </h4>
                    </div>
                    <div className="flex items-center space-x-2">
                      {turnoEditando?.id === turno.id ? (
                        <>
                          <button
                            onClick={salvarTurno}
                            className="bg-green-600 text-white px-3 py-1 rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500"
                          >
                            <FaSave className="inline mr-1" />
                            Salvar
                          </button>
                          <button
                            onClick={cancelarEdicaoTurno}
                            className="bg-gray-600 text-white px-3 py-1 rounded-md hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500"
                          >
                            Cancelar
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => editarTurno(turno)}
                          className="bg-blue-600 text-white px-3 py-1 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          Editar
                        </button>
                      )}
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Horas de Trabalho
                      </label>
                      {turnoEditando?.id === turno.id ? (
                        <input
                          type="number"
                          step="0.5"
                          min="0"
                          max="24"
                          value={turnoEditando.horasTrabalho}
                          onChange={(e) => setTurnoEditando(prev => ({
                            ...prev,
                            horasTrabalho: parseFloat(e.target.value) || 0
                          }))}
                          className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                        />
                      ) : (
                        <div className="w-full p-2 border border-gray-300 rounded-md bg-gray-50 text-gray-700">
                          {turno.horasTrabalho}h
                        </div>
                      )}
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Horas de Paradas
                      </label>
                      {turnoEditando?.id === turno.id ? (
                        <input
                          type="number"
                          step="0.5"
                          min="0"
                          max="24"
                          value={turnoEditando.horasParadas}
                          onChange={(e) => setTurnoEditando(prev => ({
                            ...prev,
                            horasParadas: parseFloat(e.target.value) || 0
                          }))}
                          className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                        />
                      ) : (
                        <div className="w-full p-2 border border-gray-300 rounded-md bg-gray-50 text-gray-700">
                          {turno.horasParadas}h
                        </div>
                      )}
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Horas Úteis
                      </label>
                      <div className="w-full p-2 border border-gray-300 rounded-md bg-blue-50 text-blue-700 font-medium">
                        {turnoEditando?.id === turno.id 
                          ? (turnoEditando.horasTrabalho - turnoEditando.horasParadas).toFixed(2)
                          : (turno.horasTrabalho - turno.horasParadas).toFixed(2)
                        }h
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            
            <div className="mt-6 p-4 bg-blue-50 rounded-lg">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-lg font-medium text-blue-900">Resumo dos Turnos</h4>
                  <p className="text-sm text-blue-700">
                    Total de horas úteis por dia considerando todos os turnos ativos
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold text-blue-600">
                    {Number(horasBase || 0).toFixed(2)}h/dia (turnos)
                  </div>
                  <div className="text-sm text-blue-600">{turnos.filter(t => t.ativo).length} turnos ativos</div>
                </div>
              </div>
            </div>

            {/* Horas Extras */}
            <div className="mt-4 p-4 bg-yellow-50 rounded-lg">
              <h4 className="text-lg font-medium text-yellow-900 mb-3">Horas Extras</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Extras Dia Útil (h)</label>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    value={extrasDiaUtil}
                    onChange={(e) => setExtrasDiaUtil(parseFloat(e.target.value) || 0)}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Extras Sábado (h)</label>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    value={extrasSabado}
                    onChange={(e) => setExtrasSabado(parseFloat(e.target.value) || 0)}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div className="flex md:justify-end">
                  <button
                    onClick={salvarExtras}
                    className="self-end bg-yellow-600 text-white px-4 py-2 rounded-md hover:bg-yellow-700 focus:outline-none focus:ring-2 focus:ring-yellow-500"
                  >
                    <FaSave className="inline mr-2" /> Salvar Extras
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {mostrarModalExportarFila && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-lg p-6 max-w-md w-full">
            <h2 className="text-xl font-bold text-gray-900 mb-4">Exportar Fila para Excel</h2>
            
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Data Inicial do Cronograma
              </label>
              <input
                type="date"
                value={dataExportarFila}
                onChange={(e) => setDataExportarFila(e.target.value)}
                className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
              />
              <p className="text-xs text-gray-500 mt-2">
                A distribuição de horas será calculada a partir desta data, respeitando a capacidade diária configurada.
              </p>
            </div>

            <div className="bg-blue-50 p-3 rounded-md mb-6">
              <p className="text-sm text-blue-800">
                <strong>Capacidade diária:</strong> {Number(horasUteisDiaUtil || 0).toFixed(2)}h (dias úteis)
                {Number(extrasSabado || 0) > 0 && ` + ${Number(extrasSabado || 0).toFixed(2)}h (sábados)`}
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setMostrarModalExportarFila(false)}
                className="flex-1 px-4 py-2 bg-gray-200 text-gray-800 rounded-md hover:bg-gray-300"
              >
                Cancelar
              </button>
              <button
                onClick={filaExportarExcel}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                Exportar
              </button>
            </div>
          </div>
        </div>
      )}
      {abaSelecionada === 'extrusao' && (
        <CalculadoraExtrusao
          ferramentasCfg={ferramentasCfg}
          apontamentos={apontamentos}
          extrairFerramenta={extrairFerramenta}
          itens={calcExtrusaoItens}
          setItens={setCalcExtrusaoItens}
          proximoId={calcExtrusaoProximoId}
          setProximoId={setCalcExtrusaoProximoId}
        />
      )}
    </div>
  )
}

function CalculadoraExtrusao({ ferramentasCfg, apontamentos, extrairFerramenta, itens, setItens, proximoId, setProximoId }) {
  const supabase = supabaseService.supabase
  const [abaAtiva, setAbaAtiva] = React.useState('calculadora') // 'calculadora' | 'cadastro'
  const [mapeamento, setMapeamento] = React.useState([])
  const [loadingMapeamento, setLoadingMapeamento] = React.useState(false)
  const [uploadStatus, setUploadStatus] = React.useState(null) // null | 'loading' | 'ok' | 'erro'
  const [uploadMsg, setUploadMsg] = React.useState('')
  const [pesoLinearMapDB, setPesoLinearMapDB] = React.useState({})
  const fileInputRef = React.useRef()

  // --- Carrega mapeamento + peso_linear do banco ---
  React.useEffect(() => {
    const carregar = async () => {
      setLoadingMapeamento(true)
      const [{ data: mapData }, { data: ferrData }] = await Promise.all([
        supabase.from('extrusao_mapeamento').select('*').order('ferramenta').order('comprimento_acabado_mm'),
        supabase.from('ferramentas_cfg').select('ferramenta, peso_linear').not('peso_linear', 'is', null)
      ])
      setMapeamento(mapData || [])
      // Consolida peso_linear por ferramenta (primeiro valor válido)
      const plMap = {}
      for (const f of (ferrData || [])) {
        const key = String(f.ferramenta || '').trim().toUpperCase()
        if (key && f.peso_linear != null && !plMap[key]) {
          plMap[key] = parseFloat(f.peso_linear)
        }
      }
      setPesoLinearMapDB(plMap)
      setLoadingMapeamento(false)
    }
    carregar()
  }, [])

  // --- Mapa ferramenta -> peso_linear (banco tem prioridade, fallback para prop) ---
  const pesoLinearMap = React.useMemo(() => {
    const map = {}
    if (ferramentasCfg) {
      for (const f of ferramentasCfg) {
        const key = String(f.ferramenta || '').trim().toUpperCase()
        if (key && f.peso_linear != null) map[key] = parseFloat(f.peso_linear)
      }
    }
    // Sobrescreve com valores buscados diretamente (mais confiável)
    return { ...map, ...pesoLinearMapDB }
  }, [ferramentasCfg, pesoLinearMapDB])

  // --- Extrai ferramenta do código: sempre NL+4D (ex: TG-2011, TCG-0170, BC-0037) ---
  const extrairFerramentaDoCodigo = (codigo) => {
    if (!codigo) return ''
    const m = String(codigo).toUpperCase().match(/^([A-Z]+)(\d{4})/)
    return m ? `${m[1]}-${m[2]}` : ''
  }

  // --- Extrai comprimento do código: sempre posição 9-12 (índice 8, 4 chars) ---
  const extrairComprimentoDoCodigo = (codigo) => {
    if (!codigo || String(codigo).length < 12) return null
    const val = parseInt(String(codigo).substring(8, 12))
    return isNaN(val) ? null : val
  }

  // --- Mapa ferramenta -> [{comprimentoAcabado, comprimentoLongo, produtoAcabado, produtoLongo}] ---
  const mapeamentoPorFerramenta = React.useMemo(() => {
    const map = {}
    for (const row of mapeamento) {
      const ferr = String(row.ferramenta || '').trim().toUpperCase()
      if (!ferr) continue
      if (!map[ferr]) map[ferr] = []
      // Deduplica por comprimento acabado
      const jaExiste = map[ferr].find(x => x.comprimentoAcabado === row.comprimento_acabado_mm)
      if (!jaExiste) {
        map[ferr].push({
          comprimentoAcabado: row.comprimento_acabado_mm,
          comprimentoLongo: row.comprimento_longo_mm,
          produtoAcabado: row.produto_acabado,
          produtoLongo: row.produto_longo,
        })
      }
    }
    // Ordenar por comprimento acabado
    for (const ferr of Object.keys(map)) {
      map[ferr].sort((a, b) => (a.comprimentoAcabado || 0) - (b.comprimentoAcabado || 0))
    }
    return map
  }, [mapeamento])

  const ferramentasDisponiveis = Object.keys(mapeamentoPorFerramenta).sort()

  // --- Autocomplete state por linha ---
  const [acInputs, setAcInputs] = React.useState({})   // id -> texto digitado
  const [acAberto, setAcAberto] = React.useState(null)  // id da linha com dropdown aberto
  const [acPos, setAcPos] = React.useState({ top: 0, left: 0, width: 0 })
  const acInputRefs = React.useRef({})

  React.useEffect(() => {
    const handler = (e) => {
      if (acAberto !== null) {
        const ref = acInputRefs.current[acAberto]
        if (ref && !ref.contains(e.target)) setAcAberto(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [acAberto])

  const abrirDropdown = (itemId) => {
    const el = acInputRefs.current[itemId]
    if (el) {
      const rect = el.getBoundingClientRect()
      setAcPos({ top: rect.bottom + window.scrollY, left: rect.left + window.scrollX, width: rect.width })
    }
    setAcAberto(itemId)
  }

  const getAcTexto = (item) => {
    if (acInputs[item.id] !== undefined) return acInputs[item.id]
    return item.ferramenta || ''
  }

  const ferramentasFiltradas = (item) => {
    const texto = getAcTexto(item).toUpperCase()
    if (!texto) return ferramentasDisponiveis
    return ferramentasDisponiveis.filter(f => f.toUpperCase().includes(texto))
  }

  const selecionarFerramenta = (itemId, valor) => {
    atualizarLinha(itemId, 'ferramenta', valor)
    atualizarLinha(itemId, 'comprimentoAcabadoKey', '')
    setAcInputs(prev => { const n = { ...prev }; delete n[itemId]; return n })
    setAcAberto(null)
  }

  // --- Itens da calculadora ---
  const adicionarLinha = () => {
    setItens(prev => [...prev, { id: proximoId, ferramenta: '', comprimentoAcabadoKey: '', qtdPecas: '' }])
    setProximoId(prev => prev + 1)
  }
  const removerLinha = (id) => setItens(prev => prev.filter(i => i.id !== id))
  const atualizarLinha = (id, campo, valor) => setItens(prev => prev.map(i => i.id === id ? { ...i, [campo]: valor } : i))

  // --- Cálculo por linha ---
  const calcularLinha = (item) => {
    const ferrKey = String(item.ferramenta || '').trim().toUpperCase()
    const opcoes = mapeamentoPorFerramenta[ferrKey] || []
    const opcaoSelecionada = opcoes.find(o => String(o.comprimentoAcabado) === String(item.comprimentoAcabadoKey))
    if (!opcaoSelecionada) return { pecasPorBarra: null, barrasNecessarias: null, kgTotal: null, retalhoMm: null, aproveitamento: null }

    const compAcabado = opcaoSelecionada.comprimentoAcabado
    const compBarra = opcaoSelecionada.comprimentoLongo
    const qtdPecas = parseFloat(item.qtdPecas)
    const pesoLinear = pesoLinearMap[ferrKey] || null

    if (!compAcabado || compAcabado <= 0 || !compBarra || compBarra <= 0 || !qtdPecas || qtdPecas <= 0) {
      return { pecasPorBarra: null, barrasNecessarias: null, kgTotal: null, retalhoMm: null, aproveitamento: null }
    }
    const pecasPorBarra = Math.floor(compBarra / compAcabado)
    if (pecasPorBarra <= 0) return { pecasPorBarra: 0, barrasNecessarias: null, kgTotal: null, retalhoMm: null, aproveitamento: null }
    const retalhoMm = compBarra - (pecasPorBarra * compAcabado)
    const aproveitamento = (pecasPorBarra * compAcabado) / compBarra * 100
    const barrasNecessarias = Math.ceil(qtdPecas / pecasPorBarra)
    const kgTotal = pesoLinear != null ? barrasNecessarias * (compBarra / 1000) * pesoLinear : null
    return { pecasPorBarra, barrasNecessarias, kgTotal, retalhoMm, aproveitamento, compBarra, compAcabado }
  }

  const resultados = itens.map(item => {
    const ferrKey = String(item.ferramenta || '').trim().toUpperCase()
    const opcoes = mapeamentoPorFerramenta[ferrKey] || []
    const opcaoSelecionada = opcoes.find(o => String(o.comprimentoAcabado) === String(item.comprimentoAcabadoKey))
    return { ...item, opcaoSelecionada, ...calcularLinha(item) }
  })
  const totalBarras = resultados.reduce((s, r) => s + (r.barrasNecessarias || 0), 0)
  const totalKg = resultados.length > 0 && resultados.every(r => r.kgTotal != null)
    ? resultados.reduce((s, r) => s + (r.kgTotal || 0), 0) : null

  // --- Upload da planilha ---
  const handleUploadPlanilha = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadStatus('loading')
    setUploadMsg('Lendo planilha...')
    try {
      const XLSX = await import('xlsx')
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(buffer)
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
      // Detectar colunas: primeira linha como header
      const header = (rows[0] || []).map(h => String(h).trim().toLowerCase())
      const colA = header.findIndex(h => h.includes('produto') && !h.includes('item') && !h.includes('perfil'))
      const colB = header.findIndex(h => h.includes('perfil') || (h.includes('item') && h.includes('perfil')) || h.includes('longo'))
      const idxA = colA >= 0 ? colA : 0
      const idxB = colB >= 0 ? colB : 1
      const dados = rows.slice(1)
        .map(r => ({ produtoAcabado: String(r[idxA] || '').trim(), produtoLongo: String(r[idxB] || '').trim() }))
        .filter(r => r.produtoAcabado && r.produtoLongo && r.produtoAcabado.length >= 10)

      if (dados.length === 0) { setUploadStatus('erro'); setUploadMsg('Nenhuma linha válida encontrada.'); return }
      setUploadMsg(`Importando ${dados.length} linhas...`)

      // Upsert em lotes de 200
      let erros = 0
      for (let i = 0; i < dados.length; i += 200) {
        const lote = dados.slice(i, i + 200)
        const { error } = await supabase.from('extrusao_mapeamento')
          .upsert(lote.map(d => ({ produto_acabado: d.produtoAcabado.toUpperCase(), produto_longo: d.produtoLongo.toUpperCase() })),
            { onConflict: 'produto_acabado,produto_longo', ignoreDuplicates: true })
        if (error) erros++
      }
      // Recarregar
      const { data: novo } = await supabase.from('extrusao_mapeamento').select('*').order('ferramenta').order('comprimento_acabado_mm')
      setMapeamento(novo || [])
      setUploadStatus('ok')
      setUploadMsg(`${dados.length} linhas importadas${erros ? ` (${erros} lotes com erro)` : ' com sucesso'}.`)
    } catch (err) {
      setUploadStatus('erro')
      setUploadMsg('Erro ao processar planilha: ' + err.message)
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const limparMapeamento = async () => {
    if (!window.confirm('Apagar todo o mapeamento? Esta ação não pode ser desfeita.')) return
    await supabase.from('extrusao_mapeamento').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    setMapeamento([])
  }

  // --- Exportar resultado ---
  const exportarExcel = async () => {
    try {
      const XLSX = await import('xlsx')
      const rows = resultados.map(r => ({
        Ferramenta: r.ferramenta || '-',
        'Produto Acabado': r.opcaoSelecionada?.produtoAcabado || '-',
        'Produto Longo': r.opcaoSelecionada?.produtoLongo || '-',
        'Comp. Acabado (mm)': r.compAcabado ?? '-',
        'Comp. Barra Longa (mm)': r.compBarra ?? '-',
        'Qtd Peças': r.qtdPecas || 0,
        'Peças/Barra': r.pecasPorBarra ?? '-',
        'Barras Necessárias': r.barrasNecessarias ?? '-',
        'Retalho (mm)': r.retalhoMm ?? '-',
        'Aproveitamento (%)': r.aproveitamento != null ? r.aproveitamento.toFixed(1) : '-',
        'Peso Linear (kg/m)': pesoLinearMap[String(r.ferramenta || '').trim().toUpperCase()] ?? 'N/D',
        'KG Total': r.kgTotal != null ? r.kgTotal.toFixed(2) : 'N/D',
      }))
      rows.push({ Ferramenta: 'TOTAL', 'Qtd Peças': resultados.reduce((s, r) => s + (parseFloat(r.qtdPecas) || 0), 0), 'Barras Necessárias': totalBarras, 'KG Total': totalKg != null ? totalKg.toFixed(2) : 'N/D' })
      const ws = XLSX.utils.json_to_sheet(rows)
      const wb2 = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb2, ws, 'Calc Extrusão')
      XLSX.writeFile(wb2, `calc_extrusao_${new Date().toISOString().slice(0, 10)}.xlsx`)
    } catch (e) { console.error(e) }
  }

  return (
    <>
    <div className="space-y-4">
      {/* Sub-abas */}
      <div className="bg-white rounded-lg shadow">
        <div className="flex border-b border-gray-200 px-4">
          {[{ key: 'calculadora', label: 'Calculadora' }, { key: 'cadastro', label: 'Cadastro de Mapeamento' }].map(a => (
            <button key={a.key} onClick={() => setAbaAtiva(a.key)}
              className={`py-3 px-4 text-sm font-medium border-b-2 -mb-px transition-colors ${abaAtiva === a.key ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {a.label}
            </button>
          ))}
        </div>

        {/* === ABA CADASTRO === */}
        {abaAtiva === 'cadastro' && (
          <div className="p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-base font-semibold text-gray-900">Mapeamento Produto Acabado × Produto Longo</h3>
                <p className="text-sm text-gray-500 mt-1">
                  Importe uma planilha com duas colunas: <strong>Produto</strong> (acabado) e <strong>Item.Perfil</strong> (barra longa).
                  O app extrai automaticamente a ferramenta e os comprimentos dos códigos.
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium">
                  <FaFileImport /> Importar Planilha
                </button>
                <button onClick={limparMapeamento}
                  className="flex items-center gap-2 px-4 py-2 bg-red-50 text-red-600 border border-red-200 rounded-lg hover:bg-red-100 text-sm font-medium">
                  <FaTrash /> Limpar Tudo
                </button>
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleUploadPlanilha} />
              </div>
            </div>

            {uploadStatus && (
              <div className={`mb-4 px-4 py-3 rounded-lg text-sm font-medium ${uploadStatus === 'ok' ? 'bg-green-50 text-green-700' : uploadStatus === 'erro' ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'}`}>
                {uploadMsg}
              </div>
            )}

            <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-3 text-xs text-yellow-800 mb-4">
              <strong>Formato esperado:</strong> Coluna A = Produto acabado (ex: <code>BC0037160074NCNV</code>) · Coluna B = Item.Perfil / Produto longo (ex: <code>BC0037165659NANV</code>) · Primeira linha = cabeçalho.
            </div>

            {loadingMapeamento ? (
              <p className="text-gray-400 text-sm">Carregando...</p>
            ) : mapeamento.length === 0 ? (
              <p className="text-gray-400 text-sm">Nenhum mapeamento cadastrado. Importe uma planilha.</p>
            ) : (
              <div className="overflow-x-auto max-h-96 overflow-y-auto border rounded-lg">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      {['Ferramenta', 'Produto Acabado', 'Comp. Acabado (mm)', 'Produto Longo', 'Comp. Longo (mm)'].map(h => (
                        <th key={h} className="px-3 py-2 text-left font-medium text-gray-500 uppercase">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {mapeamento.map(row => (
                      <tr key={row.id} className="hover:bg-gray-50">
                        <td className="px-3 py-1.5 font-medium text-blue-700">{row.ferramenta}</td>
                        <td className="px-3 py-1.5 font-mono text-gray-700">{row.produto_acabado}</td>
                        <td className="px-3 py-1.5 text-center font-semibold">{row.comprimento_acabado_mm ?? '?'}</td>
                        <td className="px-3 py-1.5 font-mono text-gray-700">{row.produto_longo}</td>
                        <td className="px-3 py-1.5 text-center font-semibold text-green-700">{row.comprimento_longo_mm ?? '?'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-gray-400 mt-2">{mapeamento.length} registros cadastrados</p>
          </div>
        )}

        {/* === ABA CALCULADORA === */}
        {abaAtiva === 'calculadora' && (
          <div className="p-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                  <FaIndustry className="text-blue-600" /> Calculadora de Extrusão
                </h3>
                <p className="text-sm text-gray-500 mt-0.5">Selecione a ferramenta e o comprimento acabado. O comprimento da barra longa e o KG são calculados automaticamente.</p>
              </div>
              <div className="flex gap-2">
                <button onClick={adicionarLinha} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium">
                  <FaPlus /> Adicionar Linha
                </button>
                <button onClick={exportarExcel} className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium">
                  <FaFileImport /> Exportar Excel
                </button>
              </div>
            </div>

            {ferramentasDisponiveis.length === 0 && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-3 text-sm text-yellow-800 mb-4">
                Nenhum mapeamento cadastrado. Acesse a aba <strong>Cadastro de Mapeamento</strong> e importe a planilha primeiro.
              </div>
            )}

            <div className="overflow-x-auto overflow-y-visible">
              <table className="w-full text-sm" style={{ overflowY: 'visible' }}>
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Ferramenta</th>
                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Comprimento Acabado</th>
                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Barra Longa</th>
                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Qtd Peças</th>
                    <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 uppercase">Pçs/Barra</th>
                    <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 uppercase">Barras</th>
                    <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 uppercase">Retalho</th>
                    <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 uppercase">Aproveit.</th>
                    <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 uppercase">KG Total</th>
                    <th className="px-3 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {resultados.map((item) => {
                    const ferrKey = String(item.ferramenta || '').trim().toUpperCase()
                    const opcoes = mapeamentoPorFerramenta[ferrKey] || []
                    const pesoLinear = pesoLinearMap[ferrKey]
                    return (
                      <tr key={item.id} className="hover:bg-gray-50 align-top">
                        {/* Ferramenta — autocomplete via portal */}
                        <td className="px-3 py-2">
                          <input
                            ref={el => acInputRefs.current[item.id] = el}
                            type="text"
                            value={getAcTexto(item)}
                            onChange={e => {
                              setAcInputs(prev => ({ ...prev, [item.id]: e.target.value }))
                              abrirDropdown(item.id)
                              if (!e.target.value) selecionarFerramenta(item.id, '')
                            }}
                            onFocus={() => abrirDropdown(item.id)}
                            placeholder="Buscar ferramenta..."
                            className="w-40 p-1.5 border border-gray-300 rounded text-sm focus:ring-blue-500 focus:border-blue-500"
                          />
                          {pesoLinear != null && <div className="text-xs text-green-600 mt-0.5">{pesoLinear} kg/m</div>}
                          {pesoLinear == null && item.ferramenta && <div className="text-xs text-orange-500 mt-0.5">Peso N/D</div>}
                        </td>
                        {/* Comprimento acabado */}
                        <td className="px-3 py-2">
                          <select
                            value={item.comprimentoAcabadoKey}
                            onChange={e => atualizarLinha(item.id, 'comprimentoAcabadoKey', e.target.value)}
                            disabled={!item.ferramenta || opcoes.length === 0}
                            className="w-40 p-1.5 border border-gray-300 rounded text-sm focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-400"
                          >
                            <option value="">— comprimento —</option>
                            {opcoes.map(o => (
                              <option key={o.comprimentoAcabado} value={String(o.comprimentoAcabado)}>
                                {o.comprimentoAcabado} mm
                              </option>
                            ))}
                          </select>
                          {item.opcaoSelecionada && (
                            <div className="text-xs text-gray-400 mt-0.5 font-mono truncate max-w-[160px]" title={item.opcaoSelecionada.produtoAcabado}>
                              {item.opcaoSelecionada.produtoAcabado}
                            </div>
                          )}
                        </td>
                        {/* Barra longa — preenchida automaticamente */}
                        <td className="px-3 py-2 text-center">
                          {item.opcaoSelecionada ? (
                            <div>
                              <span className="inline-block px-2 py-1 bg-gray-100 rounded text-sm font-semibold text-gray-800">
                                {item.opcaoSelecionada.comprimentoLongo} mm
                              </span>
                              <div className="text-xs text-gray-400 mt-0.5 font-mono truncate max-w-[140px]" title={item.opcaoSelecionada.produtoLongo}>
                                {item.opcaoSelecionada.produtoLongo}
                              </div>
                            </div>
                          ) : <span className="text-gray-300">—</span>}
                        </td>
                        {/* Qtd peças */}
                        <td className="px-3 py-2">
                          <input type="number" min="1" value={item.qtdPecas}
                            onChange={e => atualizarLinha(item.id, 'qtdPecas', e.target.value)}
                            placeholder="Ex: 5000"
                            className="w-28 p-1.5 border border-gray-300 rounded text-sm focus:ring-blue-500 focus:border-blue-500" />
                        </td>
                        {/* Resultados */}
                        <td className="px-3 py-2 text-center">
                          {item.pecasPorBarra != null ? <span className="font-semibold text-blue-700">{item.pecasPorBarra}</span> : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {item.barrasNecessarias != null
                            ? <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue-100 text-blue-800 font-bold text-sm"><FaBars className="w-3 h-3" />{item.barrasNecessarias}</span>
                            : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {item.retalhoMm != null
                            ? <span className={`text-sm font-medium ${item.retalhoMm > 100 ? 'text-orange-600' : 'text-gray-600'}`}>{item.retalhoMm} mm</span>
                            : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {item.aproveitamento != null
                            ? <span className={`text-sm font-semibold ${item.aproveitamento >= 90 ? 'text-green-600' : item.aproveitamento >= 75 ? 'text-yellow-600' : 'text-red-600'}`}>{item.aproveitamento.toFixed(1)}%</span>
                            : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {item.kgTotal != null
                            ? <span className="inline-flex items-center gap-1 font-bold text-gray-800"><FaWeight className="w-3 h-3 text-gray-400" />{item.kgTotal.toFixed(1)} kg</span>
                            : item.barrasNecessarias != null
                              ? <span className="text-xs text-orange-500">Peso N/D</span>
                              : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <button onClick={() => removerLinha(item.id)} className="text-red-400 hover:text-red-600"><FaTrash className="w-3.5 h-3.5" /></button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Totais */}
            {itens.length > 0 && (
              <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-blue-50 rounded-lg p-4 text-center">
                  <div className="text-xs text-blue-600 font-medium uppercase mb-1">Produtos</div>
                  <div className="text-2xl font-bold text-blue-800">{itens.length}</div>
                </div>
                <div className="bg-purple-50 rounded-lg p-4 text-center">
                  <div className="text-xs text-purple-600 font-medium uppercase mb-1">Total Peças</div>
                  <div className="text-2xl font-bold text-purple-800">{resultados.reduce((s, r) => s + (parseFloat(r.qtdPecas) || 0), 0).toLocaleString('pt-BR')}</div>
                </div>
                <div className="bg-green-50 rounded-lg p-4 text-center">
                  <div className="text-xs text-green-600 font-medium uppercase mb-1">Total Barras</div>
                  <div className="text-2xl font-bold text-green-800">{totalBarras > 0 ? totalBarras.toLocaleString('pt-BR') : '—'}</div>
                </div>
                <div className="bg-orange-50 rounded-lg p-4 text-center">
                  <div className="text-xs text-orange-600 font-medium uppercase mb-1">Total KG</div>
                  <div className="text-2xl font-bold text-orange-800">{totalKg != null ? `${totalKg.toFixed(1)} kg` : 'N/D'}</div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>

    {/* Portal: dropdown autocomplete ferramenta */}
    {acAberto !== null && ferramentasFiltradas(itens.find(i => i.id === acAberto) || {}).length > 0 &&
      ReactDOM.createPortal(
        <ul
          style={{ position: 'absolute', top: acPos.top, left: acPos.left, minWidth: acPos.width, zIndex: 99999 }}
          className="bg-white border border-gray-200 rounded-lg shadow-xl max-h-64 overflow-y-auto"
        >
          {ferramentasFiltradas(itens.find(i => i.id === acAberto) || {}).map(f => {
            const selectedItem = itens.find(i => i.id === acAberto)
            return (
              <li
                key={f}
                onMouseDown={() => selecionarFerramenta(acAberto, f)}
                className={`px-3 py-2 text-sm cursor-pointer hover:bg-blue-50 hover:text-blue-700 ${
                  selectedItem?.ferramenta === f ? 'bg-blue-50 font-semibold text-blue-700' : 'text-gray-800'
                }`}
              >{f}</li>
            )
          })}
        </ul>,
        document.body
      )
    }
    </>
  )
}

export default PrevisaoTrabalho
