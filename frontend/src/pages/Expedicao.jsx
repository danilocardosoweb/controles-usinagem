import React, { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { FaTruck, FaBarcode, FaCheckCircle, FaBox, FaClipboardList, FaHistory, FaPrint, FaPlus, FaSearch, FaFilter, FaDownload, FaTimes, FaCheck, FaExclamationTriangle, FaTrash, FaCubes, FaTruckLoading, FaCalendarAlt, FaUser, FaFolderOpen, FaSync, FaExternalLinkAlt, FaShippingFast, FaUndo, FaBoxes, FaEdit } from 'react-icons/fa'
import { supabase } from '../config/supabase'
import useSupabase from '../hooks/useSupabase'
import supabaseService from '../services/SupabaseService'
import ExpedicaoService from '../services/ExpedicaoService'
import ExpedicaoImpressao from '../components/ExpedicaoImpressao'
import KitsPanel from '../components/expedicao/KitsPanel'
import CorrecaoApontamentoModal from '../components/CorrecaoApontamentoModal'
import { useAuth } from '../contexts/AuthContext'
import { isAdmin } from '../utils/auth'
import * as XLSX from 'xlsx'

export default function Expedicao() {
  const { user } = useAuth()
  const navigate = useNavigate()
  
  // Verificar se usuário é administrador
  const userIsAdmin = useMemo(() => isAdmin(user), [user])
  
  const { items: apontamentos } = useSupabase('apontamentos')
  const { items: apontamentosParaKits, loadItems: loadApontamentosParaKits } = useSupabase('apontamentos') // Carrega TODOS os apontamentos sem filtro de data
  const { items: maquinas } = useSupabase('maquinas')
  const { items: romaneios, loadItems: loadRomaneios } = useSupabase('expedicao_romaneios')
  const { items: romaneioItens, loadItems: loadRomaneioItens } = useSupabase('expedicao_romaneio_itens')
  const { items: ferramentasCfg } = useSupabase('ferramentas_cfg')

  const [tab, setTab] = useState('dashboard')
  // Período padrão de 90 dias para incluir racks antigos pendentes
  const [filtroDataInicio, setFiltroDataInicio] = useState(() => {
    const data = new Date()
    data.setDate(data.getDate() - 90)
    return data.toISOString().slice(0, 10)
  })
  const [filtroDataFim, setFiltroDataFim] = useState(() => new Date().toISOString().slice(0, 10))
  const [filtroCliente, setFiltroCliente] = useState('')
  const [filtroProduto, setFiltroProduto] = useState('')
  const [filtroStatus, setFiltroStatus] = useState('ativos')
  const [historicoCliente, setHistoricoCliente] = useState('')
  const [historicoDataInicio, setHistoricoDataInicio] = useState('')
  const [historicoDataFim, setHistoricoDataFim] = useState('')
  
  const [romaneioModalAberto, setRomaneioModalAberto] = useState(false)
  const [conferenciaModalAberto, setConferenciaModalAberto] = useState(false)
  const [impressaoModalAberto, setImpressaoModalAberto] = useState(false)
  const [detalhesModalAberto, setDetalhesModalAberto] = useState(false)
  const [romaneioSelecionado, setRomaneioSelecionado] = useState(null)
  const [racksParaRomaneio, setRacksParaRomaneio] = useState([])
  const [itensRomaneioSelecionado, setItensRomaneioSelecionado] = useState([])
  const [clienteSelecionadoDetalhes, setClienteSelecionadoDetalhes] = useState(null)
  const [racksModalSelecionados, setRacksModalSelecionados] = useState([])
  
  const [itensConferencia, setItensConferencia] = useState([])
  const [itensConferidos, setItensConferidos] = useState({})
  const [itensNaoEncontrados, setItensNaoEncontrados] = useState({})   // id -> true
  const [observacoesDivergencia, setObservacoesDivergencia] = useState({}) // id -> string
  const [itemObsAberto, setItemObsAberto] = useState(null)  // id do item com painel de obs aberto

  // Correção de apontamentos
  const [correcaoApontamentoAberto, setCorrecaoApontamentoAberto] = useState(false)
  const [apontamentoParaCorrigir, setApontamentoParaCorrigir] = useState(null)
  const [buscaRackCorrecao, setBuscaRackCorrecao] = useState('')
  const [resultadoBuscaCorrecao, setResultadoBuscaCorrecao] = useState([])

  // Simulações de cubagem
  const [simulacoesSalvas, setSimulacoesSalvas] = useState([])
  const [loadingSims, setLoadingSims] = useState(false)
  const [simFiltro, setSimFiltro] = useState('')
  const [simFiltroStatus, setSimFiltroStatus] = useState('todos')
  const [simFiltroTipo, setSimFiltroTipo] = useState('todos')
  const [confirmDeleteSim, setConfirmDeleteSim] = useState(null)
  const [confirmLiberarSim, setConfirmLiberarSim] = useState(null)
  const [confirmExpedirSim, setConfirmExpedirSim] = useState(null)

  const carregarSimulacoes = async () => {
    setLoadingSims(true)
    try {
      const { data, error } = await supabase
        .from('simulacoes_cubagem')
        .select('*')
        .order('criado_em', { ascending: false })
        .limit(100)
      if (error) throw error
      setSimulacoesSalvas(data || [])
    } catch (e) { console.error('Erro ao carregar simulações:', e) }
    finally { setLoadingSims(false) }
  }

  const deletarSimulacao = async (simId) => {
    try {
      await supabase.from('simulacao_cubagem_itens').delete().eq('simulacao_id', simId)
      await supabase.from('simulacoes_cubagem').delete().eq('id', simId)
      setSimulacoesSalvas(prev => prev.filter(s => s.id !== simId))
      setConfirmDeleteSim(null)
    } catch (e) { console.error('Erro ao deletar simulação:', e) }
  }

  const liberarCarga = async (simId) => {
    try {
      // Reverter para rascunho — libera os racks para novo planejamento
      await supabase.from('simulacoes_cubagem').update({ status: 'cancelado', tipo: 'simulacao' }).eq('id', simId)
      setSimulacoesSalvas(prev => prev.map(s => s.id === simId ? { ...s, status: 'cancelado', tipo: 'simulacao' } : s))
      setConfirmLiberarSim(null)
    } catch (e) { console.error('Erro ao liberar carga:', e) }
  }

  const expedirCarga = async (simId) => {
    try {
      await supabase.from('simulacoes_cubagem').update({ status: 'expedido' }).eq('id', simId)
      setSimulacoesSalvas(prev => prev.map(s => s.id === simId ? { ...s, status: 'expedido' } : s))
      setConfirmExpedirSim(null)
    } catch (e) { console.error('Erro ao expedir carga:', e) }
  }

  const simulacoesFiltradas = useMemo(() => {
    return simulacoesSalvas.filter(sim => {
      if (simFiltroTipo !== 'todos' && (sim.tipo || 'simulacao') !== simFiltroTipo) return false
      if (simFiltroStatus !== 'todos' && sim.status !== simFiltroStatus) return false
      if (simFiltro) {
        const busca = simFiltro.toLowerCase()
        const match = (sim.titulo || '').toLowerCase().includes(busca)
          || (sim.cliente || '').toLowerCase().includes(busca)
          || (sim.caminhao_titulo || '').toLowerCase().includes(busca)
          || (sim.descricao || '').toLowerCase().includes(busca)
          || (sim.numero_carga ? `carga ${sim.numero_carga}`.includes(busca) : false)
        if (!match) return false
      }
      return true
    })
  }, [simulacoesSalvas, simFiltro, simFiltroStatus, simFiltroTipo])

  const abrirSimulacao = (sim) => {
    const url = `${window.location.origin}/montagem-palete?from=expedicao&simulacao=${sim.id}`
    window.open(url, '_blank')
  }

  // Identificar racks que já estão em qualquer romaneio ativo (pendente, conferido, expedido)
  // Excluir apenas racks de romaneios cancelados ou com divergência já liberada
  const racksExpedidosSet = useMemo(() => {
    const romaneiosAtivos = (Array.isArray(romaneios) ? romaneios : [])
      .filter(r => r.status !== 'cancelado')
      .map(r => r.id)
    
    const itensEmRomaneio = (Array.isArray(romaneioItens) ? romaneioItens : [])
      .filter(item => romaneiosAtivos.includes(item.romaneio_id))
      .map(item => String(item.rack_ou_pallet || '').trim().toUpperCase())
    
    // Também incluir racks de apontamentos que foram marcados com romaneio_numero
    const apontamentosComRomaneio = (Array.isArray(apontamentos) ? apontamentos : [])
      .filter(a => {
        const rn = String(a.romaneio_numero || '').trim()
        return rn.length > 0 && !/^0+$/.test(rn)
      })
      .map(a => String(a.rack_acabado || a.rackAcabado || a.rack_ou_pallet || a.rackOuPallet || '').trim().toUpperCase())
      .filter(rack => rack.length > 0)
    
    return new Set([...itensEmRomaneio, ...apontamentosComRomaneio])
  }, [romaneios, romaneioItens, apontamentos])

  const racksProtos = useMemo(() => {
    // Quando há filtro de cliente ou produto, buscar em todas as datas (ignorar range)
    const buscarTodasDatas = filtroCliente || filtroProduto
    
    return (Array.isArray(apontamentos) ? apontamentos : [])
      .filter(a => {
        // Filtrar apontamentos de usinagem que têm rack_acabado preenchido
        const rackBase = a.rack_acabado || a.rackAcabado || a.rack_ou_pallet || a.rackOuPallet || ''
        const rackNormalizado = String(rackBase).trim().toUpperCase()
        const temRack = rackNormalizado.length > 0
        if (!temRack) return false
        
        // Excluir racks que já foram expedidos (comparando em maiúsculas)
        if (racksExpedidosSet.has(rackNormalizado)) return false
        
        // Se estiver buscando por cliente ou produto, ignora o range de data
        if (!buscarTodasDatas) {
          const dataApontamento = new Date(a.created_at).toISOString().slice(0, 10)
          if (filtroDataInicio && dataApontamento < filtroDataInicio) return false
          if (filtroDataFim && dataApontamento > filtroDataFim) return false
        }
        
        if (filtroCliente && !String(a.cliente || '').toLowerCase().includes(filtroCliente.toLowerCase())) return false
        if (filtroProduto && !String(a.produto || a.codigoPerfil || '').toLowerCase().includes(filtroProduto.toLowerCase())) return false
        return true
      })
  }, [apontamentos, filtroDataInicio, filtroDataFim, filtroCliente, filtroProduto, racksExpedidosSet])

  // Apontamentos para Kits: SEM filtro de data, inclui TODOS os racks não expedidos
  const apontamentosParaKitsFiltrados = useMemo(() => {
    const resultado = (Array.isArray(apontamentosParaKits) ? apontamentosParaKits : [])
      .filter(a => {
        // Filtrar apontamentos que têm rack_acabado preenchido
        const rackBase = a.rack_acabado || a.rackAcabado || a.rack_ou_pallet || a.rackOuPallet || ''
        const rackNormalizado = String(rackBase).trim().toUpperCase()
        const temRack = rackNormalizado.length > 0
        if (!temRack) return false
        
        // Excluir racks que já foram expedidos ou marcados com romaneio_numero
        if (racksExpedidosSet.has(rackNormalizado)) return false
        const rnVal = String(a.romaneio_numero || '').trim()
        if (rnVal.length > 0 && !/^0+$/.test(rnVal)) return false
        
        return true
      })
    
    console.log('🎯 apontamentosParaKitsFiltrados:')
    console.log('  - Total apontamentos recebidos:', apontamentosParaKits.length)
    console.log('  - Apontamentos com rack não expedido:', resultado.length)
    console.log('  - Clientes únicos:', new Set(resultado.map(a => a.cliente)).size)
    
    // Debug específico para racks TRAMONTINA USI-128x
    const racksTramontinaTodos = (Array.isArray(apontamentosParaKits) ? apontamentosParaKits : [])
      .filter(a => {
        const rack = String(a.rack_acabado || a.rackAcabado || a.rack_ou_pallet || '').trim().toUpperCase()
        return rack.startsWith('USI-128')
      })
    console.log('🔍 Todos USI-128x:', racksTramontinaTodos.map(a => ({
      rack: a.rack_acabado || a.rack_ou_pallet,
      cliente: a.cliente,
      data: a.created_at,
      romaneio_numero: a.romaneio_numero,
      noExpedidos: racksExpedidosSet.has(String(a.rack_acabado || a.rack_ou_pallet || '').trim().toUpperCase())
    })))
    
    return resultado
  }, [apontamentosParaKits, racksExpedidosSet])

  const racksAgrupados = useMemo(() => {
    const grupos = {}
    racksProtos.forEach(a => {
      const rack = String(a.rack_acabado || a.rackAcabado || a.rack_ou_pallet || a.rackOuPallet || 'SEM_RACK').trim()
      if (!grupos[rack]) {
        grupos[rack] = {
          rack,
          apontamentos: [],
          totalPecas: 0,
          clientes: new Set(),
          produtos: new Set(),
          pedidos: new Set(),
          comprimentos: new Set()
        }
      }
      grupos[rack].apontamentos.push(a)
      grupos[rack].totalPecas += Number(a.quantidade || 0)
      grupos[rack].clientes.add(String(a.cliente || ''))
      grupos[rack].produtos.add(String(a.produto || a.codigoPerfil || ''))
      const pedidoValor = String(a.pedido_seq || a.ordemTrabalho || a.ordem_trabalho || a.pedido_cliente || a.pedidoCliente || '').trim()
      if (pedidoValor) grupos[rack].pedidos.add(pedidoValor)
      const compVal = a.comprimento_acabado_mm || a.comprimentoAcabadoMm
      if (compVal) grupos[rack].comprimentos.add(`${compVal}mm`)
    })
    return Object.values(grupos)
  }, [racksProtos])

  const maquinasMap = useMemo(() => {
    const map = {}
    ;(Array.isArray(maquinas) ? maquinas : []).forEach(m => {
      if (!m) return
      if (m.id) map[m.id] = m.nome || m.descricao || m.codigo || m.id
    })
    return map
  }, [maquinas])

  const getAmarradosInfo = (produto, comprimentoMm, totalPecas) => {
    if (!totalPecas || !produto) return null
    const cfgs = Array.isArray(ferramentasCfg) ? ferramentasCfg : []
    const s = String(produto).toUpperCase()
    const m3 = s.match(/^([A-Z]{3})([A-Z0-9]+)/)
    const m2 = s.match(/^([A-Z]{2})([A-Z0-9]+)/)
    const m = m3 || m2
    if (!m) return null
    const letras = m[1]
    const resto = m[2]
    const qtdDig = m3 ? 3 : 4
    let nums = ''
    for (const ch of resto) {
      if (/[0-9]/.test(ch)) nums += ch
      else if (ch === 'O') nums += '0'
      if (nums.length === qtdDig) break
    }
    if (nums.length < qtdDig) nums = nums.padEnd(qtdDig, '0')
    const ferr = `${letras}-${nums}`
    const compNorm = comprimentoMm ? String(parseInt(String(comprimentoMm).replace(/\D/g, ''), 10)) : ''
    const cfg = cfgs.find(c => {
      if (String(c?.ferramenta || '').toUpperCase() !== ferr) return false
      if (!compNorm) return true
      const cc = String(c?.comprimento_mm || '').replace(/\D/g, '')
      return cc ? String(parseInt(cc, 10)) === compNorm : true
    })
    const porAm = Number(cfg?.pecas_por_amarrado || 0)
    if (porAm <= 0) return null
    const inteiros = Math.floor(totalPecas / porAm)
    const sobra = totalPecas % porAm
    return { inteiros, sobra, porAm }
  }

  const clientesAgrupados = useMemo(() => {
    const grupos = {}
    racksAgrupados.forEach(rack => {
      const clientes = rack.clientes.size ? Array.from(rack.clientes) : ['SEM CLIENTE']
      clientes.forEach(cliente => {
        const chave = String(cliente || 'SEM CLIENTE').trim() || 'SEM CLIENTE'
        if (!grupos[chave]) {
          grupos[chave] = {
            cliente: chave,
            racks: [],
            totalPecas: 0,
            produtos: new Set(),
            pedidos: new Set()
          }
        }
        grupos[chave].racks.push(rack)
        grupos[chave].totalPecas += rack.totalPecas
        rack.produtos.forEach(prod => grupos[chave].produtos.add(prod))
        rack.pedidos.forEach(ped => grupos[chave].pedidos.add(ped))
      })
    })
    return Object.values(grupos).sort((a, b) => a.cliente.localeCompare(b.cliente))
  }, [racksAgrupados])

  const indicadores = useMemo(() => {
    const hoje = new Date().toISOString().slice(0, 10)
    const romaneiosHoje = (Array.isArray(romaneios) ? romaneios : [])
      .filter(r => new Date(r.data_criacao).toISOString().slice(0, 10) === hoje)
    
    return {
      racksProntos: racksAgrupados.length,
      totalPecas: racksAgrupados.reduce((sum, r) => sum + r.totalPecas, 0),
      romaneiosPendentes: romaneiosHoje.filter(r => r.status === 'pendente').length,
      romaneiosConferidos: romaneiosHoje.filter(r => r.status === 'conferido').length,
      romaneiosExpedidos: romaneiosHoje.filter(r => r.status === 'expedido').length
    }
  }, [racksAgrupados, romaneios])

  const gerarNumeroRomaneio = () => {
    const hoje = new Date()
    const dd = String(hoje.getDate()).padStart(2, '0')
    const mm = String(hoje.getMonth() + 1).padStart(2, '0')
    const yyyy = hoje.getFullYear()
    const timestamp = Date.now().toString().slice(-4)
    return `ROM-${dd}${mm}${yyyy}-${timestamp}`
  }

  const criarRomaneio = async () => {
    if (racksParaRomaneio.length === 0) {
      alert('Selecione pelo menos um rack')
      return
    }

    try {
      const numeroRomaneio = gerarNumeroRomaneio()
      const totalPecas = racksParaRomaneio.reduce((sum, rack) => sum + rack.totalPecas, 0)
      const clientesDoRomaneio = [...new Set(
        racksParaRomaneio.flatMap(rack => Array.from(rack.clientes)).filter(Boolean)
      )].join(', ')

      const cfgFerramentas = Array.isArray(ferramentasCfg) ? ferramentasCfg : []
      const buscarPesoLinear = (ferramenta, comprimentoMm) => {
        const ferrNorm = String(ferramenta || '').toUpperCase().trim()
        const compNorm = Number(comprimentoMm || 0) || 0
        if (!ferrNorm) return 0

        const porFerrComp = cfgFerramentas.find((cfg) => {
          const ferrCfg = String(cfg?.ferramenta || '').toUpperCase().trim()
          const compCfg = Number(cfg?.comprimento_mm || 0) || 0
          return ferrCfg === ferrNorm && compCfg === compNorm
        })
        if (porFerrComp) return Number(porFerrComp.peso_linear || 0) || 0

        const porFerramenta = cfgFerramentas.find((cfg) => {
          const ferrCfg = String(cfg?.ferramenta || '').toUpperCase().trim()
          return ferrCfg === ferrNorm
        })
        return Number(porFerramenta?.peso_linear || 0) || 0
      }

      const itensBase = []

      racksParaRomaneio.forEach(rack => {
        rack.apontamentos.forEach(apontamento => {
          const produtoCod = apontamento.produto || apontamento.codigoPerfil || ''

          const ferramentaExtraida = (() => {
            const m = produtoCod.match(/^([A-Za-z]+)(\d{4})/)
            if (!m) return produtoCod
            return `${m[1]}-${m[2]}`
          })()

          const compRaw = apontamento.comprimento_acabado_mm ?? apontamento.comprimentoAcabadoMm
          const compNum = compRaw !== null && compRaw !== undefined && compRaw !== ''
            ? Number(String(compRaw).replace(/\D/g, '')) || null
            : null

          const loteExterno = apontamento.lote_externo || apontamento.loteExterno ||
            (Array.isArray(apontamento.lotes_externos) && apontamento.lotes_externos.length > 0
              ? apontamento.lotes_externos[0]
              : '') || ''

          const qtd = Number(apontamento.quantidade || 0) || 0
          const pesoLinear = buscarPesoLinear(ferramentaExtraida, compNum)
          const compM = (Number(compNum || 0) || 0) / 1000
          const pesoEstimadoKg = (pesoLinear > 0 && compM > 0 && qtd > 0)
            ? Number((pesoLinear * compM * qtd).toFixed(3))
            : null

          itensBase.push({
            apontamento_id: apontamento.id,
            rack_ou_pallet: apontamento.rack_acabado || apontamento.rackAcabado || apontamento.rack_ou_pallet || apontamento.rackOuPallet,
            produto: produtoCod,
            ferramenta: ferramentaExtraida,
            comprimento_acabado_mm: compNum,
            quantidade: apontamento.quantidade,
            cliente: apontamento.cliente,
            pedido_seq: apontamento.pedido_seq || apontamento.ordemTrabalho || apontamento.ordem_trabalho || apontamento.pedido_cliente || apontamento.pedidoCliente,
            lote_externo: loteExterno,
            peso_estimado_kg: pesoEstimadoKg,
            status_item: 'pendente'
          })
        })
      })

      const pesoTotalEstimadoKg = Number(
        itensBase.reduce((sum, item) => sum + (Number(item.peso_estimado_kg || 0) || 0), 0).toFixed(3)
      )

      const { data: novoRomaneio, error: erroRomaneio } = await supabaseService.supabase
        .from('expedicao_romaneios')
        .insert({
          numero_romaneio: numeroRomaneio,
          status: 'pendente',
          usuario_criacao: user?.nome || 'Sistema',
          total_racks: racksParaRomaneio.length,
          total_pecas: totalPecas,
          cliente: clientesDoRomaneio,
          peso_total_estimado_kg: pesoTotalEstimadoKg > 0 ? pesoTotalEstimadoKg : null
        })
        .select()

      if (erroRomaneio) throw erroRomaneio

      const romaneioId = novoRomaneio[0].id

      const itens = itensBase.map(item => ({
        ...item,
        romaneio_id: romaneioId,
      }))

      const { error: erroItens } = await supabaseService.supabase
        .from('expedicao_romaneio_itens')
        .insert(itens)

      if (erroItens) throw erroItens

      // Marcar romaneio_numero nos apontamentos para bloquear reuso
      for (const rack of racksParaRomaneio) {
        for (const apontamento of rack.apontamentos) {
          if (apontamento.id) {
            await supabaseService.supabase
              .from('apontamentos')
              .update({ romaneio_numero: numeroRomaneio })
              .eq('id', apontamento.id)
          }
        }
      }

      alert(`✅ Romaneio ${numeroRomaneio} criado com sucesso!`)
      setRomaneioModalAberto(false)
      setRacksParaRomaneio([])
      await loadRomaneios()
      await loadRomaneioItens()
      // Recarregar apontamentos para atualizar a lista de racks disponíveis
      window.location.reload()
    } catch (erro) {
      console.error('Erro ao criar romaneio:', erro)
      alert('Erro ao criar romaneio: ' + erro.message)
    }
  }

  const iniciarConferencia = async (romaneio) => {
    setRomaneioSelecionado(romaneio)
    setItensConferidos({})
    setItensNaoEncontrados({})
    setObservacoesDivergencia({})
    setItemObsAberto(null)
    setConferenciaModalAberto(true)
    try {
      const { data: itens, error } = await supabaseService.supabase
        .from('expedicao_romaneio_itens')
        .select('*')
        .eq('romaneio_id', romaneio.id)
      if (error) throw error
      setItensConferencia(itens || [])
    } catch (erro) {
      alert('Erro ao carregar itens: ' + erro.message)
    }
  }

  const abrirImpressao = async (romaneio) => {
    try {
      const { data: itens, error } = await supabaseService.supabase
        .from('expedicao_romaneio_itens')
        .select('*')
        .eq('romaneio_id', romaneio.id)
      if (error) throw error
      setItensRomaneioSelecionado(itens || [])
      setRomaneioSelecionado(romaneio)
      setImpressaoModalAberto(true)
    } catch (erro) {
      alert('Erro ao carregar romaneio: ' + erro.message)
    }
  }

  const abrirDetalhesCliente = (clienteGroup) => {
    setClienteSelecionadoDetalhes(clienteGroup)
    setRacksModalSelecionados([])
    setDetalhesModalAberto(true)
  }

  const toggleRackModal = (rack) => {
    setRacksModalSelecionados(prev =>
      prev.some(r => r.rack === rack.rack)
        ? prev.filter(r => r.rack !== rack.rack)
        : [...prev, rack]
    )
  }

  const adicionarRacksSelecionadosAoRomaneio = () => {
    const novos = racksModalSelecionados.filter(
      r => !racksParaRomaneio.some(rr => rr.rack === r.rack)
    )
    setRacksParaRomaneio(prev => [...prev, ...novos])
    setDetalhesModalAberto(false)
    setRomaneioModalAberto(true)
  }

  const finalizarConferencia = async () => {
    if (!romaneioSelecionado) return

    const itensDivergentes = itensConferencia.filter(item => !itensConferidos[item.id])
    const temDivergencia = itensDivergentes.length > 0

    if (temDivergencia) {
      const msg = `⚠️ ${itensDivergentes.length} item(s) não conferido(s):\n\n` +
        itensDivergentes.map(i => `• ${i.rack_ou_pallet}${itensNaoEncontrados[i.id] ? ' — NÃO ENCONTRADO' : ''}`).join('\n') +
        '\n\nItens não encontrados serão liberados para um próximo romaneio.\nDeseja finalizar assim mesmo?'
      if (!window.confirm(msg)) return
    }

    try {
      for (const item of itensConferencia) {
        const conferido = !!itensConferidos[item.id]
        const naoEncontrado = !!itensNaoEncontrados[item.id]
        const obs = observacoesDivergencia[item.id] || null

        const statusItem = conferido ? 'conferido' : naoEncontrado ? 'nao_encontrado' : 'divergencia'

        await supabaseService.supabase
          .from('expedicao_romaneio_itens')
          .update({
            status_item: statusItem,
            quantidade_conferida: conferido ? item.quantidade : 0,
            observacao_item: obs,
          })
          .eq('id', item.id)

        // Liberar apontamento para próximo romaneio se não encontrado
        if (!conferido && item.apontamento_id) {
          await supabaseService.supabase
            .from('apontamentos')
            .update({ romaneio_numero: null })
            .eq('id', item.apontamento_id)
        }
      }

      const novoStatus = temDivergencia ? 'conferido_divergencia' : 'conferido'
      await supabaseService.supabase
        .from('expedicao_romaneios')
        .update({ status: novoStatus, data_conferencia: new Date().toISOString(), usuario_conferencia: user?.nome })
        .eq('id', romaneioSelecionado.id)

      const msgFinal = temDivergencia
        ? `✅ Conferência finalizada com ${itensDivergentes.length} divergência(s). Itens não encontrados foram liberados para novo romaneio.`
        : '✅ Conferência finalizada com sucesso!'
      alert(msgFinal)
      setConferenciaModalAberto(false)
      setRomaneioSelecionado(null)
      await loadRomaneios()
      await loadRomaneioItens()
    } catch (erro) {
      console.error('Erro ao finalizar conferência:', erro)
      alert('Erro: ' + erro.message)
    }
  }

  const expedir = async (romaneio) => {
    const linha1 = `Romaneio: ${romaneio.numero_romaneio}`
    const linha2 = romaneio.cliente ? `Cliente: ${romaneio.cliente}` : ''
    const linha3 = `Racks: ${romaneio.total_racks} | Peças: ${romaneio.total_pecas}`
    const confirmado = window.confirm(
      `Confirmar expedição?\n\n${linha1}${linha2 ? '\n' + linha2 : ''}\n${linha3}\n\nEsta ação irá marcar o romaneio como EXPEDIDO.`
    )
    if (!confirmado) return

    try {
      await supabaseService.supabase
        .from('expedicao_romaneios')
        .update({ status: 'expedido', data_expedicao: new Date().toISOString(), usuario_expedicao: user?.nome })
        .eq('id', romaneio.id)

      alert(`✅ Romaneio ${romaneio.numero_romaneio} expedido com sucesso!`)
      await loadRomaneios()
    } catch (erro) {
      alert('Erro: ' + erro.message)
    }
  }

  const deletarRomaneio = async (romaneio) => {
    const conf1 = window.confirm(
      `⚠️ ATENÇÃO — AÇÃO IRREVERSÍVEL\n\nVocê está prestes a DELETAR permanentemente:\n\nRomaneio: ${romaneio.numero_romaneio}\nCliente: ${romaneio.cliente || '-'}\nStatus: ${romaneio.status?.toUpperCase()}\n\nTodos os itens também serão deletados.\n\nDeseja continuar?`
    )
    if (!conf1) return

    const conf2 = window.confirm(
      `Confirmação final:\n\nDigite OK para deletar o romaneio ${romaneio.numero_romaneio} permanentemente.\n\nEsta ação NÃO pode ser desfeita.`
    )
    if (!conf2) return

    try {
      const { error: erroItens } = await supabaseService.supabase
        .from('expedicao_romaneio_itens')
        .delete()
        .eq('romaneio_id', romaneio.id)
      if (erroItens) throw erroItens

      const { error: erroRom } = await supabaseService.supabase
        .from('expedicao_romaneios')
        .delete()
        .eq('id', romaneio.id)
      if (erroRom) throw erroRom

      await loadRomaneios()
    } catch (erro) {
      alert('Erro ao deletar: ' + erro.message)
    }
  }

  // Buscar apontamentos para correção
  const buscarApontamentosParaCorrecao = async () => {
    if (!buscaRackCorrecao.trim()) {
      alert('Digite um rack para buscar')
      return
    }
    
    const termo = buscaRackCorrecao.trim().toUpperCase()
    const encontrados = (Array.isArray(apontamentos) ? apontamentos : [])
      .filter(a => {
        const rack = String(a.rack_acabado || a.rack_ou_pallet || '').trim().toUpperCase()
        return rack.includes(termo)
      })
    
    setResultadoBuscaCorrecao(encontrados)
    console.log('🔍 Apontamentos encontrados para correção:', encontrados.length, encontrados)
  }

  const abrirCorrecaoApontamento = (apontamento) => {
    setApontamentoParaCorrigir(apontamento)
    setCorrecaoApontamentoAberto(true)
  }

  const handleSucessoCorrecao = () => {
    setCorrecaoApontamentoAberto(false)
    setApontamentoParaCorrigir(null)
    // Recarregar a busca
    buscarApontamentosParaCorrecao()
    alert('✅ Correção salva com sucesso!')
  }

  // Voltar romaneio um passo atrás no fluxo:
  // expedido → (só via restaurar, somente admin)
  // conferido → pendente (racks permanecem presos, conferência pode ser refeita)
  // pendente → cancelado (racks liberados para disponíveis)
  const voltarPassoRomaneio = async (romaneio) => {
    const isConferido = romaneio.status === 'conferido' || romaneio.status === 'conferido_divergencia'
    const isPendente = romaneio.status === 'pendente'

    if (isConferido) {
      const confirmado = window.confirm(
        `Desfazer conferência do romaneio ${romaneio.numero_romaneio}?\n\n` +
        `O romaneio voltará para status PENDENTE.\n` +
        `Os racks permanecerão reservados neste romaneio e poderão ser conferidos novamente.`
      )
      if (!confirmado) return
      try {
        await supabaseService.supabase
          .from('expedicao_romaneios')
          .update({ status: 'pendente', data_conferencia: null, usuario_conferencia: null })
          .eq('id', romaneio.id)
        // Resetar status_item dos itens para pendente
        await supabaseService.supabase
          .from('expedicao_romaneio_itens')
          .update({ status_item: 'pendente', quantidade_conferida: null, observacao_item: null })
          .eq('romaneio_id', romaneio.id)
        await loadRomaneios()
        await loadRomaneioItens()
      } catch (erro) {
        alert('Erro ao desfazer conferência: ' + erro.message)
      }
    } else if (isPendente) {
      const confirmado = window.confirm(
        `Cancelar o romaneio ${romaneio.numero_romaneio}?\n\n` +
        `Os racks voltarão a ficar DISPONÍVEIS para um novo romaneio.`
      )
      if (!confirmado) return
      try {
        // 1. Buscar itens do romaneio para liberar os apontamentos
        const { data: itens, error: erroBusca } = await supabaseService.supabase
          .from('expedicao_romaneio_itens')
          .select('apontamento_id')
          .eq('romaneio_id', romaneio.id)
        if (erroBusca) throw erroBusca

        // 2. Remover romaneio_numero dos apontamentos → racks voltam para disponíveis
        if (itens && itens.length > 0) {
          const apontamentoIds = itens.map(i => i.apontamento_id).filter(Boolean)
          if (apontamentoIds.length > 0) {
            const { error: erroApt } = await supabaseService.supabase
              .from('apontamentos')
              .update({ romaneio_numero: null })
              .in('id', apontamentoIds)
            if (erroApt) throw erroApt
          }
        }

        // 3. Marcar romaneio como cancelado
        const { error } = await supabaseService.supabase
          .from('expedicao_romaneios')
          .update({ status: 'cancelado' })
          .eq('id', romaneio.id)
        if (error) throw error

        await loadRomaneios()
        window.location.reload()
      } catch (erro) {
        alert('Erro ao cancelar romaneio: ' + erro.message)
      }
    }
  }

  const restaurarRomaneio = async (romaneio) => {
    const conf1 = window.confirm(
      `🔄 RESTAURAR RACKS\n\n` +
      `Romaneio: ${romaneio.numero_romaneio}\n` +
      `Cliente: ${romaneio.cliente || '-'}\n` +
      `Racks: ${romaneio.total_racks}\n` +
      `Peças: ${romaneio.total_pecas}\n\n` +
      `Esta ação irá:\n` +
      `• Excluir o romaneio permanentemente\n` +
      `• Remover as baixas de estoque associadas\n` +
      `• Restaurar os racks para a lista de "Racks Prontos"\n\n` +
      `Deseja continuar?`
    )
    if (!conf1) return

    const conf2 = window.confirm(
      `⚠️ CONFIRMAÇÃO FINAL\n\n` +
      `Digite OK para confirmar a restauração do romaneio ${romaneio.numero_romaneio}.\n\n` +
      `Os racks voltarão a ficar disponíveis para novo romaneio.`
    )
    if (!conf2) return

    try {
      // 1. Buscar itens do romaneio para saber quais racks/baixas remover
      const { data: itens, error: erroBusca } = await supabaseService.supabase
        .from('expedicao_romaneio_itens')
        .select('*')
        .eq('romaneio_id', romaneio.id)
      if (erroBusca) throw erroBusca

      // 2. Remover romaneio_numero dos apontamentos para liberar os racks
      if (itens && itens.length > 0) {
        const apontamentoIds = itens.map(i => i.apontamento_id).filter(Boolean)
        if (apontamentoIds.length > 0) {
          const { error: erroApt } = await supabaseService.supabase
            .from('apontamentos')
            .update({ romaneio_numero: null })
            .in('id', apontamentoIds)
          if (erroApt) throw erroApt
        }
      }

      // 3. Remover baixas de estoque associadas (marcar como estornadas)
      if (itens && itens.length > 0) {
        for (const item of itens) {
          await supabaseService.supabase
            .from('exp_estoque_baixas')
            .update({ 
              estornado: true, 
              estornado_em: new Date().toISOString(),
              estornado_por: user?.nome,
              motivo_estorno: `Restauração do romaneio ${romaneio.numero_romaneio}`
            })
            .eq('lote_codigo', item.lote)
            .eq('produto', item.produto)
        }
      }

      // 4. Deletar itens do romaneio
      const { error: erroItens } = await supabaseService.supabase
        .from('expedicao_romaneio_itens')
        .delete()
        .eq('romaneio_id', romaneio.id)
      if (erroItens) throw erroItens

      // 5. Deletar o romaneio
      const { error: erroRom } = await supabaseService.supabase
        .from('expedicao_romaneios')
        .delete()
        .eq('id', romaneio.id)
      if (erroRom) throw erroRom

      alert(`✅ Romaneio ${romaneio.numero_romaneio} restaurado com sucesso!\n\nOs racks voltaram a ficar disponíveis na aba "Racks Prontos".`)
      await loadRomaneios()
      await loadRomaneioItens()
      // Recarregar apontamentos para atualizar a lista de racks disponíveis
      window.location.reload()
    } catch (erro) {
      console.error('Erro ao restaurar:', erro)
      alert('Erro ao restaurar romaneio: ' + erro.message)
    }
  }

  const exportarParaExcel = async (romaneio) => {
    try {
      const { data: itens, error: erroItens } = await supabaseService.supabase
        .from('expedicao_romaneio_itens')
        .select('*')
        .eq('romaneio_id', romaneio.id)
      if (erroItens) throw erroItens

      // Formatador pt-BR para números
      const formatarNumero = (valor) => {
        if (valor === null || valor === undefined || valor === '') return ''
        const num = Number(valor)
        return isNaN(num) ? '' : num.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
      }

      const dados = [
        ['ROMANEIO DE EXPEDIÇÃO'],
        ['Número:', romaneio.numero_romaneio],
        ['Data de Criação:', new Date(romaneio.data_criacao).toLocaleDateString('pt-BR')],
        ['Status:', romaneio.status.toUpperCase()],
        ['Total de Racks:', romaneio.total_racks],
        ['Total de Peças:', romaneio.total_pecas],
        ['Peso Total Estimado (kg):', formatarNumero(romaneio.peso_total_estimado_kg)],
        [],
        ['ITENS DO ROMANEIO'],
        ['Rack', 'Produto', 'Ferramenta', 'Comp. Acabado (mm)', 'Quantidade', 'Peso Estimado (kg)', 'Cliente', 'Pedido', 'Pedido Cliente', 'Lote Externo', 'Status']
      ]

      itens.forEach(item => {
        dados.push([
          item.rack_ou_pallet,
          item.produto,
          item.ferramenta || '',
          item.comprimento_acabado_mm || '',
          item.quantidade,
          formatarNumero(item.peso_estimado_kg),
          item.cliente || '',
          item.pedido_seq || '',
          item.pedido_cliente || '',
          item.lote_externo || '',
          item.status_item || 'pendente'
        ])
      })

      const ws = XLSX.utils.aoa_to_sheet(dados)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Romaneio')
      XLSX.writeFile(wb, `${romaneio.numero_romaneio}.xlsx`)
    } catch (erro) {
      alert('Erro ao exportar: ' + erro.message)
    }
  }

  const romaneiosFiltrados = useMemo(() => {
    const lista = Array.isArray(romaneios) ? [...romaneios] : []
    const normalizarData = (rom) => {
      const bruta = rom?.data_expedicao || rom?.data_conferencia || rom?.data_criacao
      if (!bruta) return null
      return new Date(bruta).toISOString().slice(0, 10)
    }

    return lista
      .filter(rom => {
        if (filtroStatus === 'ativos') return rom.status === 'pendente' || rom.status === 'conferido'
        if (filtroStatus === 'todos') return true
        return rom.status === filtroStatus
      })
      .filter(rom => {
        const dataRom = normalizarData(rom)
        if (historicoDataInicio && (!dataRom || dataRom < historicoDataInicio)) return false
        if (historicoDataFim && (!dataRom || dataRom > historicoDataFim)) return false
        if (historicoCliente && !String(rom.cliente || '').toLowerCase().includes(historicoCliente.toLowerCase())) return false
        return true
      })
      .sort((a, b) => {
        const dataA = new Date(a.data_expedicao || a.data_conferencia || a.data_criacao || 0).getTime()
        const dataB = new Date(b.data_expedicao || b.data_conferencia || b.data_criacao || 0).getTime()
        return dataB - dataA
      })
  }, [romaneios, filtroStatus, historicoCliente, historicoDataInicio, historicoDataFim])

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <FaTruck className="text-blue-600 text-3xl" />
            <h1 className="text-3xl font-bold text-gray-800">Expedição</h1>
          </div>
        </div>

        {/* Indicadores */}
        <div className="grid grid-cols-5 gap-4 mb-8">
          <div className="bg-white p-4 rounded-lg shadow border-l-4 border-green-500">
            <div className="text-gray-600 text-sm font-medium">Racks Prontos</div>
            <div className="text-3xl font-bold text-gray-800">{indicadores.racksProntos}</div>
          </div>
          <div className="bg-white p-4 rounded-lg shadow border-l-4 border-blue-500">
            <div className="text-gray-600 text-sm font-medium">Total Peças</div>
            <div className="text-3xl font-bold text-gray-800">{indicadores.totalPecas}</div>
          </div>
          <div className="bg-white p-4 rounded-lg shadow border-l-4 border-yellow-500">
            <div className="text-gray-600 text-sm font-medium">Romaneios Pendentes</div>
            <div className="text-3xl font-bold text-gray-800">{indicadores.romaneiosPendentes}</div>
          </div>
          <div className="bg-white p-4 rounded-lg shadow border-l-4 border-orange-500">
            <div className="text-gray-600 text-sm font-medium">Em Conferência</div>
            <div className="text-3xl font-bold text-gray-800">{indicadores.romaneiosConferidos}</div>
          </div>
          <div className="bg-white p-4 rounded-lg shadow border-l-4 border-purple-500">
            <div className="text-gray-600 text-sm font-medium">Expedidos Hoje</div>
            <div className="text-3xl font-bold text-gray-800">{indicadores.romaneiosExpedidos}</div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-4 mb-6 border-b border-gray-200 items-center">
          <button
            onClick={() => setTab('dashboard')}
            className={`px-4 py-3 font-medium flex items-center gap-2 ${tab === 'dashboard' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-600'}`}
          >
            <FaBox /> Racks Prontos
          </button>
          <button
            onClick={() => setTab('kits')}
            className={`px-4 py-3 font-medium flex items-center gap-2 ${tab === 'kits' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-600'}`}
          >
            <FaBoxes /> Kits
          </button>
          {userIsAdmin && (
            <button
              onClick={() => setTab('correcao')}
              className={`px-4 py-3 font-medium flex items-center gap-2 ${tab === 'correcao' ? 'border-b-2 border-orange-600 text-orange-600' : 'text-gray-600'}`}
            >
              <FaEdit /> Correção
            </button>
          )}
          <button
            onClick={() => setTab('historico')}
            className={`px-4 py-3 font-medium flex items-center gap-2 ${tab === 'historico' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-600'}`}
          >
            <FaHistory /> Histórico
          </button>
          <button
            onClick={() => { setTab('simulacoes'); carregarSimulacoes() }}
            className={`px-4 py-3 font-medium flex items-center gap-2 ${tab === 'simulacoes' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-600'}`}
          >
            <FaTruckLoading /> Simulações
          </button>
          <a
            href={`${window.location.origin}/montagem-palete?from=expedicao`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              const url = `${window.location.origin}/montagem-palete?from=expedicao`
              console.log('🔗 Montagem do Palete - URL:', url)
              console.log('🔗 window.location.origin:', window.location.origin)
              // Deixar o comportamento padrão do link acontecer (abrir nova aba)
            }}
            className="ml-auto mb-1 flex items-center gap-2 px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold rounded-lg shadow-sm transition-colors cursor-pointer"
            title="Abrir módulo de Montagem do Palete em nova aba"
          >
            <FaCubes /> Montagem do Palete ↗
          </a>
        </div>

        {/* Conteúdo */}
        {tab === 'dashboard' && (
          <div className="space-y-6">
            {/* Filtros */}
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="flex flex-wrap gap-3 items-end">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-gray-600">De</label>
                  <input
                    type="date"
                    value={filtroDataInicio}
                    onChange={(e) => setFiltroDataInicio(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded text-sm"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-gray-600">Até</label>
                  <input
                    type="date"
                    value={filtroDataFim}
                    onChange={(e) => setFiltroDataFim(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded text-sm"
                  />
                </div>
                <div className="flex flex-col gap-1 flex-1">
                  <label className="text-xs font-medium text-gray-600">Cliente</label>
                  <input
                    type="text"
                    placeholder="Filtrar por cliente..."
                    value={filtroCliente}
                    onChange={(e) => setFiltroCliente(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded text-sm"
                  />
                </div>
                <div className="flex flex-col gap-1 flex-1">
                  <label className="text-xs font-medium text-gray-600">Produto</label>
                  <input
                    type="text"
                    placeholder="Filtrar por produto..."
                    value={filtroProduto}
                    onChange={(e) => setFiltroProduto(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded text-sm"
                  />
                </div>
                <button
                  onClick={() => { 
                    const dataFim = new Date()
                    const dataInicio = new Date()
                    dataInicio.setDate(dataInicio.getDate() - 90)
                    setFiltroDataInicio(dataInicio.toISOString().slice(0,10)); 
                    setFiltroDataFim(dataFim.toISOString().slice(0,10)); 
                    setFiltroCliente(''); 
                    setFiltroProduto('') 
                  }}
                  className="px-3 py-2 text-sm border border-gray-300 rounded text-gray-600 hover:bg-gray-100"
                >
                  Limpar
                </button>
              </div>
            </div>

            {/* Tabela por Cliente */}
            <div className="bg-white rounded-lg shadow overflow-hidden">
              {clientesAgrupados.length === 0 ? (
                <div className="p-12 text-center text-gray-500">
                  <FaBox className="mx-auto text-4xl text-gray-300 mb-3" />
                  <p className="font-medium">Nenhum rack encontrado para o período selecionado</p>
                  <p className="text-sm mt-1">Ajuste os filtros de data ou cliente</p>
                </div>
              ) : (
                <table className="w-full">
                  <thead className="bg-gray-100 border-b">
                    <tr>
                      <th className="px-6 py-3 text-left text-sm font-medium text-gray-700">Cliente</th>
                      <th className="px-6 py-3 text-left text-sm font-medium text-gray-700">Racks</th>
                      <th className="px-6 py-3 text-left text-sm font-medium text-gray-700">Produtos</th>
                      <th className="px-6 py-3 text-left text-sm font-medium text-gray-700">Pedidos</th>
                      <th className="px-6 py-3 text-left text-sm font-medium text-gray-700">Total Peças</th>
                      <th className="px-6 py-3 text-left text-sm font-medium text-gray-700">Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clientesAgrupados.map((cg, idx) => (
                      <tr key={idx} className="border-b hover:bg-gray-50">
                        <td className="px-6 py-4">
                          <span className="font-semibold text-blue-700">{cg.cliente}</span>
                        </td>
                        <td className="px-6 py-4">
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                            {cg.racks.length} rack{cg.racks.length !== 1 ? 's' : ''}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {Array.from(cg.produtos).slice(0, 2).join(', ')}{cg.produtos.size > 2 ? ` +${cg.produtos.size - 2}` : ''}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {cg.pedidos.size ? Array.from(cg.pedidos).slice(0, 2).join(', ') + (cg.pedidos.size > 2 ? ` +${cg.pedidos.size - 2}` : '') : '-'}
                        </td>
                        <td className="px-6 py-4 font-bold text-gray-800">{cg.totalPecas.toLocaleString('pt-BR')} PC</td>
                        <td className="px-6 py-4">
                          <button
                            onClick={() => abrirDetalhesCliente(cg)}
                            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 font-medium"
                          >
                            Ver Racks
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {tab === 'correcao' && userIsAdmin && (
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-lg shadow">
              <h3 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
                <FaEdit className="text-orange-500" />
                Correção de Apontamentos
              </h3>
              <p className="text-sm text-gray-600 mb-4">
                Busque apontamentos pelo Rack Acabado (ex: USI-1246) para corrigir informações como Lote Externo, Pedido Cliente, etc.
              </p>
              
              <div className="flex gap-3 mb-6">
                <input
                  type="text"
                  value={buscaRackCorrecao}
                  onChange={(e) => setBuscaRackCorrecao(e.target.value)}
                  placeholder="Digite o rack (ex: USI-1246)..."
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                  onKeyPress={(e) => e.key === 'Enter' && buscarApontamentosParaCorrecao()}
                />
                <button
                  onClick={buscarApontamentosParaCorrecao}
                  className="px-6 py-2 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg flex items-center gap-2"
                >
                  <FaSearch /> Buscar
                </button>
              </div>

              {resultadoBuscaCorrecao.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="px-4 py-2 text-left text-sm font-medium text-gray-700">Rack</th>
                        <th className="px-4 py-2 text-left text-sm font-medium text-gray-700">Produto</th>
                        <th className="px-4 py-2 text-left text-sm font-medium text-gray-700">Cliente</th>
                        <th className="px-4 py-2 text-left text-sm font-medium text-gray-700">Lote Externo</th>
                        <th className="px-4 py-2 text-left text-sm font-medium text-gray-700">Pedido Cliente</th>
                        <th className="px-4 py-2 text-left text-sm font-medium text-gray-700">Ação</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {resultadoBuscaCorrecao.map((apt) => (
                        <tr key={apt.id} className="hover:bg-gray-50">
                          <td className="px-4 py-2 font-semibold text-gray-800">{apt.rack_acabado || apt.rack_ou_pallet || '-'}</td>
                          <td className="px-4 py-2 text-sm text-gray-600">{apt.produto || '-'}</td>
                          <td className="px-4 py-2 text-sm text-gray-600">{apt.cliente || '-'}</td>
                          <td className="px-4 py-2 text-sm text-gray-600">{apt.lote_externo || '-'}</td>
                          <td className="px-4 py-2 text-sm text-gray-600">{apt.pedido_cliente || '-'}</td>
                          <td className="px-4 py-2">
                            <button
                              onClick={() => abrirCorrecaoApontamento(apt)}
                              className="px-3 py-1 bg-blue-500 hover:bg-blue-600 text-white text-sm rounded flex items-center gap-1"
                            >
                              <FaEdit /> Corrigir
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              
              {buscaRackCorrecao && resultadoBuscaCorrecao.length === 0 && (
                <div className="text-center py-8 text-gray-500">
                  Nenhum apontamento encontrado para o rack "{buscaRackCorrecao}"
                </div>
              )}
            </div>
          </div>
        )}
        
        {tab === 'correcao' && !userIsAdmin && (
          <div className="bg-white p-8 rounded-lg shadow text-center">
            <FaExclamationTriangle className="text-4xl text-orange-500 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-800 mb-2">Acesso Restrito</h3>
            <p className="text-gray-600">
              Apenas administradores podem acessar a funcionalidade de correção de apontamentos.
            </p>
            <button
              onClick={() => setTab('dashboard')}
              className="mt-4 px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg"
            >
              Voltar para Racks Prontos
            </button>
          </div>
        )}

        {tab === 'historico' && (
          <div className="space-y-4">
          {/* Filtros do histórico */}
          <div className="bg-white p-3 rounded-lg shadow flex flex-wrap gap-2 items-center">
            <span className="text-sm font-medium text-gray-600 mr-1">Status:</span>
            {[
              { value: 'ativos', label: 'Ativos', color: 'bg-blue-100 text-blue-800 border-blue-300' },
              { value: 'pendente', label: 'Pendente', color: 'bg-yellow-100 text-yellow-800 border-yellow-300' },
              { value: 'conferido', label: 'Conferido', color: 'bg-orange-100 text-orange-800 border-orange-300' },
              { value: 'expedido', label: 'Expedido', color: 'bg-green-100 text-green-800 border-green-300' },
              { value: 'cancelado', label: 'Cancelado', color: 'bg-red-100 text-red-800 border-red-300' },
              { value: 'todos', label: 'Todos', color: 'bg-gray-100 text-gray-700 border-gray-300' },
            ].map(op => (
              <button
                key={op.value}
                onClick={() => setFiltroStatus(op.value)}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-all ${
                  filtroStatus === op.value
                    ? op.color + ' ring-2 ring-offset-1 ring-current'
                    : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
                }`}
              >
                {op.label}
              </button>
            ))}
          </div>

          <div className="bg-white p-3 rounded-lg shadow flex flex-wrap gap-3 items-end">
            <div className="flex flex-col">
              <label className="text-xs font-medium text-gray-600">Cliente</label>
              <input
                type="text"
                value={historicoCliente}
                onChange={(e) => setHistoricoCliente(e.target.value)}
                placeholder="Filtrar por cliente"
                className="px-3 py-2 border border-gray-300 rounded text-sm"
              />
            </div>
            <div className="flex flex-col">
              <label className="text-xs font-medium text-gray-600">Data inicial</label>
              <input
                type="date"
                value={historicoDataInicio}
                onChange={(e) => setHistoricoDataInicio(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded text-sm"
              />
            </div>
            <div className="flex flex-col">
              <label className="text-xs font-medium text-gray-600">Data final</label>
              <input
                type="date"
                value={historicoDataFim}
                onChange={(e) => setHistoricoDataFim(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded text-sm"
              />
            </div>
            {(historicoCliente || historicoDataInicio || historicoDataFim) && (
              <button
                onClick={() => {
                  setHistoricoCliente('')
                  setHistoricoDataInicio('')
                  setHistoricoDataFim('')
                }}
                className="ml-auto px-3 py-2 text-xs text-blue-600 font-semibold"
              >
                Limpar filtros
              </button>
            )}
          </div>

          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-100 border-b">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-medium text-gray-700">Romaneio</th>
                  <th className="px-6 py-3 text-left text-sm font-medium text-gray-700">Cliente</th>
                  <th className="px-6 py-3 text-left text-sm font-medium text-gray-700">Data</th>
                  <th className="px-6 py-3 text-left text-sm font-medium text-gray-700">Racks</th>
                  <th className="px-6 py-3 text-left text-sm font-medium text-gray-700">Peças</th>
                  <th className="px-6 py-3 text-left text-sm font-medium text-gray-700">Status</th>
                  <th className="px-6 py-3 text-left text-sm font-medium text-gray-700">Ações</th>
                </tr>
              </thead>
              <tbody>
                {romaneiosFiltrados.map((rom) => (
                  <tr key={rom.id} className="border-b hover:bg-gray-50">
                    <td className="px-6 py-3 font-medium text-gray-800">{rom.numero_romaneio}</td>
                    <td className="px-6 py-3 text-sm font-medium text-blue-700">{rom.cliente || '-'}</td>
                    <td className="px-6 py-3 text-sm text-gray-600">{new Date(rom.data_criacao).toLocaleDateString('pt-BR')}</td>
                    <td className="px-6 py-3 text-sm text-gray-600">{rom.total_racks}</td>
                    <td className="px-6 py-3 text-sm text-gray-600">{rom.total_pecas}</td>
                    <td className="px-6 py-3">
                      <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                        rom.status === 'pendente' ? 'bg-yellow-100 text-yellow-800' :
                        rom.status === 'conferido' ? 'bg-orange-100 text-orange-800' :
                        rom.status === 'cancelado' ? 'bg-red-100 text-red-800' :
                        'bg-green-100 text-green-800'
                      }`}>
                        {rom.status.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-sm space-x-3 flex">
                      <button
                        onClick={() => abrirImpressao(rom)}
                        className="text-purple-600 hover:text-purple-800 font-medium flex items-center gap-1"
                        title="Imprimir romaneio"
                      >
                        <FaPrint className="w-4 h-4" /> Imprimir
                      </button>
                      <button
                        onClick={() => exportarParaExcel(rom)}
                        className="text-green-600 hover:text-green-800 font-medium flex items-center gap-1"
                        title="Exportar para Excel"
                      >
                        <FaDownload className="w-4 h-4" /> Excel
                      </button>
                      {rom.status === 'pendente' && (
                        <button
                          onClick={() => iniciarConferencia(rom)}
                          className="text-blue-600 hover:text-blue-800 font-medium"
                        >
                          Conferir
                        </button>
                      )}
                      {rom.status === 'conferido' && (
                        <button
                          onClick={() => expedir(rom)}
                          className="text-green-600 hover:text-green-800 font-medium"
                        >
                          Expedir
                        </button>
                      )}
                      {rom.status === 'conferido' || rom.status === 'conferido_divergencia' ? (
                        <button
                          onClick={() => voltarPassoRomaneio(rom)}
                          className="text-orange-500 hover:text-orange-700 font-medium flex items-center gap-1"
                          title="Desfazer conferência — volta para Pendente"
                        >
                          <FaUndo className="w-3 h-3" /> Desfazer
                        </button>
                      ) : rom.status === 'pendente' ? (
                        <button
                          onClick={() => voltarPassoRomaneio(rom)}
                          className="text-red-500 hover:text-red-700 font-medium flex items-center gap-1"
                          title="Cancelar romaneio — racks voltam para disponíveis"
                        >
                          <FaTimes className="w-3 h-3" /> Cancelar
                        </button>
                      ) : null}
                      {user?.nivel_acesso === 'admin' || user?.role === 'admin' ? (
                        <button
                          onClick={() => deletarRomaneio(rom)}
                          className="text-red-700 hover:text-red-900 font-medium flex items-center gap-1"
                          title="Deletar romaneio permanentemente (Admin)"
                        >
                          <FaTrash className="w-3 h-3" /> Deletar
                        </button>
                      ) : null}
                      {(user?.nivel_acesso === 'admin' || user?.role === 'admin') && rom.status === 'expedido' && (
                        <button
                          onClick={() => restaurarRomaneio(rom)}
                          className="text-orange-600 hover:text-orange-800 font-medium flex items-center gap-1"
                          title="Restaurar racks para disponíveis (Admin)"
                        >
                          <FaHistory className="w-3 h-3" /> Restaurar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>
        )}

        {tab === 'kits' && (
          <KitsPanel
            apontamentos={apontamentosParaKitsFiltrados}
            romaneios={romaneios}
            romaneioItens={romaneioItens}
            user={user}
            loadRomaneios={loadRomaneios}
            loadRomaneioItens={loadRomaneioItens}
            loadApontamentos={loadApontamentosParaKits}
          />
        )}

        {tab === 'simulacoes' && (
          <div className="space-y-4">
            {/* Filtros */}
            <div className="bg-white p-4 rounded-lg shadow space-y-3">
              <div className="flex flex-wrap gap-3 items-end">
                <div className="flex-1 min-w-[200px] relative">
                  <label className="text-xs font-medium text-gray-600 block mb-1">Buscar</label>
                  <div className="relative">
                    <FaSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-3 h-3" />
                    <input
                      type="text"
                      value={simFiltro}
                      onChange={(e) => setSimFiltro(e.target.value)}
                      placeholder="Título, cliente, caminhão, nº carga..."
                      className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-400"
                    />
                  </div>
                </div>
                <button
                  onClick={carregarSimulacoes}
                  disabled={loadingSims}
                  className="px-3 py-2 rounded-lg border border-gray-300 text-xs font-medium text-gray-600 hover:bg-gray-50 flex items-center gap-1.5"
                >
                  <FaSync className={`w-3 h-3 ${loadingSims ? 'animate-spin' : ''}`} /> Atualizar
                </button>
              </div>
              <div className="flex flex-wrap gap-3 items-center">
                <span className="text-xs font-medium text-gray-500">Tipo:</span>
                <div className="flex gap-1.5">
                  {[
                    { value: 'todos', label: 'Todos' },
                    { value: 'carga', label: 'Cargas', color: 'bg-amber-100 text-amber-700 border-amber-300' },
                    { value: 'simulacao', label: 'Simulações', color: 'bg-slate-100 text-slate-600 border-slate-300' },
                  ].map(op => (
                    <button
                      key={op.value}
                      onClick={() => setSimFiltroTipo(op.value)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                        simFiltroTipo === op.value
                          ? (op.color || 'bg-gray-100 text-gray-700 border-gray-300') + ' ring-2 ring-offset-1 ring-current'
                          : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
                      }`}
                    >
                      {op.label}
                    </button>
                  ))}
                </div>
                <span className="text-xs font-medium text-gray-500 ml-4">Status:</span>
                <div className="flex gap-1.5">
                  {[
                    { value: 'todos', label: 'Todos', color: 'bg-gray-100 text-gray-700 border-gray-300' },
                    { value: 'rascunho', label: 'Rascunho', color: 'bg-slate-100 text-slate-700 border-slate-300' },
                    { value: 'confirmado', label: 'Confirmado', color: 'bg-emerald-100 text-emerald-700 border-emerald-300' },
                    { value: 'expedido', label: 'Expedido', color: 'bg-blue-100 text-blue-700 border-blue-300' },
                    { value: 'cancelado', label: 'Cancelado', color: 'bg-red-100 text-red-700 border-red-300' },
                  ].map(op => (
                    <button
                      key={op.value}
                      onClick={() => setSimFiltroStatus(op.value)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                        simFiltroStatus === op.value
                          ? op.color + ' ring-2 ring-offset-1 ring-current'
                          : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
                      }`}
                    >
                      {op.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Contagem */}
            <div className="flex items-center justify-between px-1">
              <p className="text-xs text-gray-500 font-medium">
                {simulacoesFiltradas.length} simulação(ões) encontrada(s)
              </p>
            </div>

            {/* Lista */}
            {loadingSims ? (
              <div className="bg-white rounded-lg shadow p-12 text-center">
                <FaSync className="animate-spin text-blue-400 w-6 h-6 mx-auto mb-3" />
                <p className="text-sm text-gray-400">Carregando simulações...</p>
              </div>
            ) : simulacoesFiltradas.length === 0 ? (
              <div className="bg-white rounded-lg shadow p-12 text-center">
                <FaTruckLoading className="text-gray-300 w-10 h-10 mx-auto mb-3" />
                <p className="text-sm text-gray-400">Nenhuma simulação encontrada.</p>
                <p className="text-xs text-gray-300 mt-1">Crie simulações na Montagem do Palete → aba Cubagem</p>
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {simulacoesFiltradas.map(sim => {
                  const isCarga = sim.tipo === 'carga'
                  const borderColor = isCarga
                    ? (sim.status === 'confirmado' ? 'border-amber-300' : sim.status === 'expedido' ? 'border-emerald-300' : sim.status === 'cancelado' ? 'border-red-200' : 'border-gray-200')
                    : 'border-gray-200'
                  return (
                  <div key={sim.id} className={`bg-white rounded-xl shadow border ${borderColor} hover:shadow-md transition-all overflow-hidden group`}>
                    {/* Barra superior para Cargas */}
                    {isCarga && (
                      <div className={`px-4 py-1.5 text-[10px] font-bold flex items-center gap-1.5 ${
                        sim.status === 'confirmado' ? 'bg-amber-50 text-amber-700 border-b border-amber-200' :
                        sim.status === 'expedido' ? 'bg-emerald-50 text-emerald-700 border-b border-emerald-200' :
                        sim.status === 'cancelado' ? 'bg-red-50 text-red-500 border-b border-red-200' :
                        'bg-blue-50 text-blue-700 border-b border-blue-200'
                      }`}>
                        <FaTruckLoading className="w-3 h-3" />
                        CARGA Nº {sim.numero_carga}
                        {sim.status === 'confirmado' && <span className="ml-auto text-[8px] bg-amber-200 text-amber-800 px-1.5 py-0.5 rounded-full">ATIVA</span>}
                        {sim.status === 'expedido' && <span className="ml-auto text-[8px] bg-emerald-200 text-emerald-800 px-1.5 py-0.5 rounded-full flex items-center gap-0.5"><FaShippingFast className="w-2 h-2" /> EXPEDIDA</span>}
                        {sim.status === 'cancelado' && <span className="ml-auto text-[8px] bg-red-200 text-red-700 px-1.5 py-0.5 rounded-full">LIBERADA</span>}
                      </div>
                    )}

                    <div className="p-4 space-y-2.5">
                      {/* Header */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <h3 className="text-sm font-bold text-gray-800 truncate">{sim.titulo}</h3>
                          {sim.descricao && <p className="text-[11px] text-gray-400 truncate mt-0.5">{sim.descricao}</p>}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {!isCarga && (
                            <span className="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full bg-slate-100 text-slate-400">Simulação</span>
                          )}
                          <span className={`text-[9px] font-bold uppercase px-2 py-0.5 rounded-full ${
                            sim.status === 'confirmado' ? 'bg-emerald-100 text-emerald-700' :
                            sim.status === 'expedido' ? 'bg-blue-100 text-blue-700' :
                            sim.status === 'cancelado' ? 'bg-red-100 text-red-700' :
                            'bg-slate-100 text-slate-500'
                          }`}>{sim.status}</span>
                        </div>
                      </div>

                      {/* Info */}
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-500">
                        {sim.cliente && (
                          <span className="flex items-center gap-1"><FaUser className="w-2.5 h-2.5 text-gray-400" /> {sim.cliente}</span>
                        )}
                        <span className="flex items-center gap-1"><FaTruckLoading className="w-2.5 h-2.5 text-gray-400" /> {sim.caminhao_titulo}</span>
                        <span className="flex items-center gap-1"><FaCalendarAlt className="w-2.5 h-2.5 text-gray-400" /> {new Date(sim.data_carga).toLocaleDateString('pt-BR')}</span>
                      </div>

                      {/* Métricas */}
                      <div className="grid grid-cols-3 gap-2 bg-gray-50 rounded-lg p-2 text-center">
                        <div>
                          <p className="text-xs font-bold text-gray-700">{sim.total_paletes}</p>
                          <p className="text-[9px] text-gray-400 uppercase">Paletes</p>
                        </div>
                        <div>
                          <p className="text-xs font-bold text-gray-700">{sim.total_camadas || '—'}</p>
                          <p className="text-[9px] text-gray-400 uppercase">Camadas</p>
                        </div>
                        <div>
                          <p className="text-xs font-bold text-gray-700">{sim.peso_estimado_kg ? (sim.peso_estimado_kg / 1000).toFixed(1) + 't' : '—'}</p>
                          <p className="text-[9px] text-gray-400 uppercase">Peso</p>
                        </div>
                      </div>

                      {/* Dimensões caminhão */}
                      <div className="text-[10px] text-gray-400 flex items-center gap-1.5">
                        <FaTruck className="w-2.5 h-2.5" />
                        {sim.caminhao_comprimento}m × {sim.caminhao_largura}m × {sim.caminhao_altura}m
                        <span className="ml-auto text-[9px] text-gray-300">{sim.modo === 'manual' ? 'Manual' : 'Auto'}</span>
                      </div>
                    </div>

                    {/* Ações */}
                    <div className="border-t border-gray-100 bg-gray-50/50 px-4 py-2.5 flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => abrirSimulacao(sim)}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg transition-all"
                      >
                        <FaExternalLinkAlt className="w-2.5 h-2.5" /> Abrir
                      </button>

                      {/* Expedir Carga — marca como expedida, sai da tela de planejamento */}
                      {isCarga && sim.status === 'confirmado' && (
                        confirmExpedirSim === sim.id ? (
                          <div className="flex items-center gap-1">
                            <button onClick={() => expedirCarga(sim.id)} className="px-2 py-1.5 bg-emerald-600 text-white text-[10px] font-bold rounded-lg hover:bg-emerald-700 flex items-center gap-1"><FaShippingFast className="w-2.5 h-2.5" /> Confirmar</button>
                            <button onClick={() => setConfirmExpedirSim(null)} className="px-2 py-1.5 border border-gray-300 text-gray-500 text-[10px] font-bold rounded-lg hover:bg-gray-100">Não</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmExpedirSim(sim.id)}
                            className="px-2 py-1.5 bg-emerald-50 text-emerald-600 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-all text-[10px] font-bold flex items-center gap-1"
                            title="Marcar carga como expedida"
                          >
                            <FaShippingFast className="w-2.5 h-2.5" /> Expedir
                          </button>
                        )
                      )}

                      {/* Liberar Carga — desfaz o vínculo, racks voltam para planejamento */}
                      {isCarga && sim.status === 'confirmado' && (
                        confirmLiberarSim === sim.id ? (
                          <div className="flex items-center gap-1">
                            <button onClick={() => liberarCarga(sim.id)} className="px-2 py-1.5 bg-amber-600 text-white text-[10px] font-bold rounded-lg hover:bg-amber-700 flex items-center gap-1"><FaUndo className="w-2.5 h-2.5" /> Liberar</button>
                            <button onClick={() => setConfirmLiberarSim(null)} className="px-2 py-1.5 border border-gray-300 text-gray-500 text-[10px] font-bold rounded-lg hover:bg-gray-100">Não</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmLiberarSim(sim.id)}
                            className="px-2 py-1.5 bg-amber-50 text-amber-600 hover:bg-amber-100 border border-amber-200 rounded-lg transition-all text-[10px] font-bold flex items-center gap-1"
                            title="Liberar racks — desfaz o planejamento da carga"
                          >
                            <FaUndo className="w-2.5 h-2.5" /> Liberar
                          </button>
                        )
                      )}

                      {/* Deletar — remove completamente a carga/simulação e devolve os racks */}
                      {confirmDeleteSim === sim.id ? (
                        <div className="flex items-center gap-1">
                          <button onClick={() => deletarSimulacao(sim.id)} className="px-2 py-1.5 bg-red-600 text-white text-[10px] font-bold rounded-lg hover:bg-red-700">Deletar</button>
                          <button onClick={() => setConfirmDeleteSim(null)} className="px-2 py-1.5 border border-gray-300 text-gray-500 text-[10px] font-bold rounded-lg hover:bg-gray-100">Não</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteSim(sim.id)}
                          className="px-2 py-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                          title="Deletar permanentemente"
                        >
                          <FaTrash className="w-3 h-3" />
                        </button>
                      )}
                    </div>

                    {/* Rodapé - data criação */}
                    <div className="px-4 py-1.5 bg-gray-50 border-t border-gray-100 text-[9px] text-gray-300">
                      Criado em {new Date(sim.criado_em).toLocaleString('pt-BR')}
                    </div>
                  </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modal Romaneio */}
      {romaneioModalAberto && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b">
              <h2 className="text-xl font-bold text-gray-800">Novo Romaneio</h2>
              <button onClick={() => setRomaneioModalAberto(false)} className="text-gray-400 hover:text-gray-600">
                <FaTimes className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="bg-blue-50 p-4 rounded border border-blue-200">
                <p className="text-sm text-blue-800">
                  <strong>{racksParaRomaneio.length}</strong> racks selecionados | <strong>{racksParaRomaneio.reduce((sum, r) => sum + r.totalPecas, 0)}</strong> peças
                </p>
              </div>

              <div className="space-y-2 max-h-64 overflow-y-auto">
                {racksParaRomaneio.map((rack, idx) => (
                  <div key={idx} className="p-3 bg-gray-50 rounded border border-gray-200 flex justify-between items-center">
                    <div>
                      <p className="font-medium text-gray-800">{rack.rack}</p>
                      <p className="text-sm text-gray-600">{rack.totalPecas} PC | {Array.from(rack.clientes).join(', ')}</p>
                    </div>
                    <button
                      onClick={() => setRacksParaRomaneio(racksParaRomaneio.filter((_, i) => i !== idx))}
                      className="text-red-600 hover:text-red-800"
                    >
                      <FaTimes />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-4 p-6 border-t bg-gray-50">
              <button
                onClick={() => setRomaneioModalAberto(false)}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100"
              >
                Cancelar
              </button>
              <button
                onClick={criarRomaneio}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
              >
                Criar Romaneio
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Conferência */}
      {conferenciaModalAberto && romaneioSelecionado && (() => {
        const totalItens = itensConferencia.length
        const totalConferidos = Object.values(itensConferidos).filter(Boolean).length
        const totalNaoEncontrados = Object.values(itensNaoEncontrados).filter(Boolean).length
        const totalTratados = totalConferidos + totalNaoEncontrados
        const progresso = totalItens > 0 ? Math.round((totalTratados / totalItens) * 100) : 0
        const todosConferidos = totalItens > 0 && totalTratados === totalItens
        const temDivergencias = totalNaoEncontrados > 0
        return (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col">
              {/* Header */}
              <div className="flex items-center justify-between p-6 border-b">
                <div>
                  <h2 className="text-xl font-bold text-gray-800">Conferência: {romaneioSelecionado.numero_romaneio}</h2>
                  {romaneioSelecionado.cliente && (
                    <p className="text-sm text-blue-600 font-medium mt-0.5">{romaneioSelecionado.cliente}</p>
                  )}
                </div>
                <button onClick={() => setConferenciaModalAberto(false)} className="text-gray-400 hover:text-gray-600">
                  <FaTimes className="w-5 h-5" />
                </button>
              </div>

              {/* Progresso */}
              <div className="px-6 pt-4 pb-2">
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-gray-600">
                    {totalConferidos} conferido(s)
                    {totalNaoEncontrados > 0 && <span className="text-red-500 ml-1">· {totalNaoEncontrados} não encontrado(s)</span>}
                    <span className="text-gray-400"> / {totalItens} total</span>
                  </span>
                  <span className={`font-bold ${todosConferidos && !temDivergencias ? 'text-green-600' : temDivergencias ? 'text-red-500' : 'text-orange-500'}`}>{progresso}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden flex">
                  <div className="h-2 bg-green-500 transition-all" style={{ width: `${totalItens > 0 ? (totalConferidos/totalItens)*100 : 0}%` }} />
                  <div className="h-2 bg-red-400 transition-all" style={{ width: `${totalItens > 0 ? (totalNaoEncontrados/totalItens)*100 : 0}%` }} />
                </div>
              </div>

              {/* Marcar todos */}
              <div className="px-6 py-2 flex justify-end">
                <button
                  onClick={() => {
                    if (todosConferidos) {
                      setItensConferidos({})
                    } else {
                      const todos = {}
                      itensConferencia.forEach(i => { todos[i.id] = true })
                      setItensConferidos(todos)
                    }
                  }}
                  className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                >
                  {todosConferidos ? 'Desmarcar todos' : 'Marcar todos'}
                </button>
              </div>

              {/* Legenda */}
              <div className="px-6 pb-1 flex gap-3 text-xs text-gray-500">
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-green-400 inline-block"/>Conferido</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-red-400 inline-block"/>Não encontrado</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-gray-300 inline-block"/>Pendente</span>
              </div>

              {/* Lista de itens clicáveis */}
              <div className="flex-1 overflow-y-auto px-6 pb-4 space-y-2">
                {itensConferencia.length === 0 ? (
                  <p className="text-center text-gray-400 py-8">Carregando itens...</p>
                ) : (
                  itensConferencia.map((item) => {
                    const conf = !!itensConferidos[item.id]
                    const naoEnc = !!itensNaoEncontrados[item.id]
                    const obsAberta = itemObsAberto === item.id
                    const obs = observacoesDivergencia[item.id] || ''

                    const toggleConferido = (e) => {
                      e.stopPropagation()
                      if (naoEnc) {
                        // sai do não-encontrado, volta para pendente
                        setItensNaoEncontrados(prev => { const n = {...prev}; delete n[item.id]; return n })
                        setItemObsAberto(null)
                      } else {
                        setItensConferidos(prev => ({ ...prev, [item.id]: !prev[item.id] }))
                      }
                    }

                    const marcarNaoEncontrado = (e) => {
                      e.stopPropagation()
                      if (naoEnc) {
                        // Desmarcar não encontrado
                        setItensNaoEncontrados(prev => { const n = {...prev}; delete n[item.id]; return n })
                        setItemObsAberto(null)
                      } else {
                        setItensConferidos(prev => { const n = {...prev}; delete n[item.id]; return n })
                        setItensNaoEncontrados(prev => ({ ...prev, [item.id]: true }))
                        setItemObsAberto(item.id)
                      }
                    }

                    return (
                      <div key={item.id} className={`rounded-lg border-2 transition-all select-none ${
                        conf    ? 'bg-green-50 border-green-400' :
                        naoEnc  ? 'bg-red-50 border-red-400' :
                                  'bg-gray-50 border-gray-200'
                      }`}>
                        {/* Linha principal */}
                        <div className="flex items-center gap-2 p-3">
                          {/* Área clicável principal → conferido */}
                          <div className="flex-1 cursor-pointer" onClick={toggleConferido}>
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-semibold text-gray-800">{item.rack_ou_pallet}</p>
                              {item.produto && (
                                <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs font-bold rounded-md">
                                  {item.produto}
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-gray-500 mt-0.5">
                              {item.ferramenta ? `Ferramenta: ${item.ferramenta}` : ''}{item.ferramenta && item.comprimento_acabado_mm ? ' · ' : ''}{item.comprimento_acabado_mm ? `${item.comprimento_acabado_mm}mm` : ''} · {item.quantidade} PC
                            </p>
                            {naoEnc && obs && (
                              <p className="text-xs text-red-600 mt-1 font-medium">📝 {obs}</p>
                            )}
                          </div>

                          {/* Botão Não Encontrado */}
                          <button
                            onClick={marcarNaoEncontrado}
                            title="Marcar como Não Encontrado"
                            className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors text-sm ${
                              naoEnc
                                ? 'bg-red-500 text-white'
                                : 'bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500'
                            }`}
                          >
                            <FaExclamationTriangle />
                          </button>

                          {/* Check conferido */}
                          <div
                            onClick={toggleConferido}
                            className={`w-8 h-8 rounded-full flex items-center justify-center border-2 flex-shrink-0 cursor-pointer transition-colors ${
                              conf ? 'bg-green-500 border-green-500' : 'border-gray-300 hover:border-green-400'
                            }`}
                          >
                            {conf && <FaCheck className="text-white text-xs" />}
                          </div>
                        </div>

                        {/* Painel de observação (abre ao marcar não encontrado) */}
                        {naoEnc && obsAberta && (
                          <div className="px-3 pb-3" onClick={e => e.stopPropagation()}>
                            <textarea
                              autoFocus
                              rows={2}
                              value={obs}
                              onChange={e => setObservacoesDivergencia(prev => ({ ...prev, [item.id]: e.target.value }))}
                              placeholder="Motivo: não localizado no estoque, material insuficiente, etc."
                              className="w-full text-xs border border-red-300 rounded-lg px-2 py-1.5 focus:outline-none focus:border-red-500 bg-white resize-none"
                            />
                            <div className="flex justify-end mt-1">
                              <button
                                onClick={() => setItemObsAberto(null)}
                                className="text-xs text-red-600 font-medium hover:text-red-800"
                              >
                                Confirmar ✓
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </div>

              {/* Footer */}
              <div className="flex gap-4 p-6 border-t bg-gray-50">
                <button
                  onClick={() => setConferenciaModalAberto(false)}
                  className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100"
                >
                  Cancelar
                </button>
                <button
                  onClick={finalizarConferencia}
                  className={`flex-1 px-6 py-2 text-white rounded-lg font-medium transition-colors ${
                    temDivergencias
                      ? 'bg-orange-500 hover:bg-orange-600'
                      : 'bg-green-600 hover:bg-green-700'
                  }`}
                >
                  {todosConferidos && !temDivergencias
                    ? 'Finalizar Conferência ✓'
                    : temDivergencias
                    ? `Finalizar com ${totalNaoEncontrados} divergência(s)`
                    : `Finalizar (${totalTratados}/${totalItens} tratados)`}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Modal Impressão */}
      {impressaoModalAberto && romaneioSelecionado && (
        <ExpedicaoImpressao
          romaneio={romaneioSelecionado}
          itens={itensRomaneioSelecionado}
          apontamentos={apontamentos}
          onClose={() => setImpressaoModalAberto(false)}
        />
      )}

      {/* Modal Correção de Apontamento */}
      {correcaoApontamentoAberto && apontamentoParaCorrigir && (
        <CorrecaoApontamentoModal
          apontamento={apontamentoParaCorrigir}
          usuarioId={user?.id}
          onClose={() => setCorrecaoApontamentoAberto(false)}
          onSucesso={handleSucessoCorrecao}
        />
      )}

      {/* Modal Racks do Cliente */}
      {detalhesModalAberto && clienteSelecionadoDetalhes && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-5xl w-full max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b">
              <div>
                <h2 className="text-xl font-bold text-gray-800">Racks Acabados — {clienteSelecionadoDetalhes.cliente}</h2>
                <p className="text-sm text-gray-500 mt-1">
                  {clienteSelecionadoDetalhes.racks.length} rack(s) • {clienteSelecionadoDetalhes.totalPecas.toLocaleString('pt-BR')} peças
                </p>
              </div>
              <button onClick={() => setDetalhesModalAberto(false)} className="text-gray-400 hover:text-gray-600">
                <FaTimes className="w-5 h-5" />
              </button>
            </div>

            {/* Barra de seleção */}
            <div className="flex items-center gap-4 px-6 py-3 bg-gray-50 border-b">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={racksModalSelecionados.length === clienteSelecionadoDetalhes.racks.length}
                  onChange={(e) =>
                    setRacksModalSelecionados(e.target.checked ? [...clienteSelecionadoDetalhes.racks] : [])
                  }
                  className="w-4 h-4"
                />
                <span className="text-sm font-medium text-gray-700">Selecionar todos</span>
              </label>
              {racksModalSelecionados.length > 0 && (
                <span className="text-sm text-blue-600 font-medium">
                  {racksModalSelecionados.length} rack(s) selecionado(s) — {racksModalSelecionados.reduce((s, r) => s + r.totalPecas, 0).toLocaleString('pt-BR')} PC
                </span>
              )}
            </div>

            {/* Tabela de racks */}
            <div className="overflow-y-auto flex-1">
              <table className="w-full">
                <thead className="bg-gray-100 border-b sticky top-0">
                  <tr>
                    <th className="px-4 py-3 w-10"></th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Rack Acabado</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Produto(s)</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Pedido</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Comp. Acabado</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Peças</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Amarrados</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Operador</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Data</th>
                  </tr>
                </thead>
                <tbody>
                  {[...clienteSelecionadoDetalhes.racks]
                    .filter(rack => rack.totalPecas >= 10)
                    .sort((a, b) => {
                      const dataA = a.apontamentos[0]?.created_at || ''
                      const dataB = b.apontamentos[0]?.created_at || ''
                      return new Date(dataB) - new Date(dataA)
                    })
                    .map((rack, idx) => {
                    const selecionado = racksModalSelecionados.some(r => r.rack === rack.rack)
                    const primeiroAp = rack.apontamentos[0] || {}
                    return (
                      <tr
                        key={idx}
                        onClick={() => toggleRackModal(rack)}
                        className={`border-b cursor-pointer transition-colors ${
                          selecionado ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-gray-50'
                        }`}
                      >
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={selecionado}
                            onChange={() => toggleRackModal(rack)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-4 h-4"
                          />
                        </td>
                        <td className="px-4 py-3 font-semibold text-gray-800">{rack.rack}</td>
                        <td className="px-4 py-3 text-sm text-gray-700">
                          {Array.from(rack.produtos).slice(0, 2).join(', ')}{rack.produtos.size > 2 ? ` +${rack.produtos.size - 2}` : ''}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-700">
                          {rack.pedidos.size ? Array.from(rack.pedidos).join(', ') : '-'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-700">
                          {rack.comprimentos && rack.comprimentos.size ? Array.from(rack.comprimentos).join(', ') : '-'}
                        </td>
                        <td className="px-4 py-3 font-bold text-gray-800">{rack.totalPecas.toLocaleString('pt-BR')} PC</td>
                        <td className="px-4 py-3 text-sm">
                          {(() => {
                            const produto = Array.from(rack.produtos)[0] || ''
                            const comp = rack.comprimentos && rack.comprimentos.size ? Array.from(rack.comprimentos)[0] : ''
                            const info = getAmarradosInfo(produto, comp, rack.totalPecas)
                            if (!info) return <span className="text-gray-400">-</span>
                            return (
                              <span className="inline-flex items-center gap-1 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5">
                                <span className="font-bold text-blue-700">{info.inteiros}</span>
                                <span className="text-[10px] text-blue-500">am.</span>
                                {info.sobra > 0 && <span className="text-[10px] font-semibold text-blue-400">+{info.sobra}pç</span>}
                              </span>
                            )
                          })()}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">{primeiroAp.operador || '-'}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {primeiroAp.created_at ? new Date(primeiroAp.created_at).toLocaleDateString('pt-BR') : '-'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Footer */}
            <div className="flex gap-4 p-6 border-t bg-gray-50">
              <button
                onClick={() => setDetalhesModalAberto(false)}
                className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100"
              >
                Fechar
              </button>
              <button
                disabled={racksModalSelecionados.length === 0}
                onClick={adicionarRacksSelecionadosAoRomaneio}
                className="flex-1 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {racksModalSelecionados.length === 0
                  ? 'Selecione ao menos 1 rack'
                  : `Criar Romaneio com ${racksModalSelecionados.length} rack(s)`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
