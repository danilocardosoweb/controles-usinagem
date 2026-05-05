import { useState, useEffect, useMemo, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext' // Importando o contexto de autenticação
import { useSupabase } from '../hooks/useSupabase'
import supabaseService from '../services/SupabaseService'
import { FaSearch, FaFilePdf, FaBroom, FaListUl, FaPlus, FaCopy, FaStar, FaWrench, FaSkullCrossbones, FaBox, FaImage, FaCubes, FaPlay, FaChartLine, FaFileAlt, FaFileExcel, FaPrint, FaRedo, FaBarcode, FaCamera, FaTimes, FaUpload, FaEye, FaTags, FaEdit } from 'react-icons/fa'
import { Line } from 'react-chartjs-2'
import { useNavigate } from 'react-router-dom'
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip } from 'chart.js'
import * as XLSX from 'xlsx'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip)
import { isVisualizador } from '../utils/auth'
import { getConfiguracaoImpressoras, getCaminhoImpressora, isImpressoraAtiva } from '../utils/impressoras'
import { buildFormularioIdentificacaoHtml, calcularTurno, resolverNomeKit } from '../utils/formularioIdentificacao'
import * as QRCode from 'qrcode'
import CorrecaoApontamentoModal from '../components/CorrecaoApontamentoModal'
import AutocompleteCodigoCliente from '../components/AutocompleteCodigoCliente'
import BuscaCodigoClienteService from '../services/BuscaCodigoClienteService'
import EtiquetasService from '../services/EtiquetasService'
import PrintService from '../services/PrintService'
import EtiquetaPreview from '../components/EtiquetaPreview'
import EtiquetaPaletePreview from '../components/EtiquetaPaletePreview'
import EtiquetaPaleteExportPreview from '../components/EtiquetaPaleteExportPreview'
import InspecaoQualidadeModal from '../components/InspecaoQualidadeModal'
import PainelRitmoTurno from '../components/PainelRitmoTurno'

// Constrói URL HTTP para abrir PDF via backend, codificando caminho base e arquivo
const buildHttpPdfUrl = (basePath, fileName) => {
  const backend = (import.meta?.env?.VITE_BACKEND_URL || 'http://localhost:8000').replace(/\/+$/, '')
  const safeBase = String(basePath || '').replace(/[\\/]+$/, '')
  const safeFile = String(fileName || '')
  return `${backend}/api/files/pdf/${encodeURIComponent(safeFile)}?base=${encodeURIComponent(safeBase)}`
}

// Normaliza o lote base conforme convenções já usadas no projeto
const extrairLoteExtrusao = (rowOuLote) => {
  if (!rowOuLote) return ''
  if (typeof rowOuLote === 'object') {
    if (rowOuLote.lote_externo) return rowOuLote.lote_externo
    if (rowOuLote.loteExterno) return rowOuLote.loteExterno
    if (typeof rowOuLote.lote === 'string') {
      const match = rowOuLote.lote.match(/-(INS|EMB)-\d+$/)
      if (match) return rowOuLote.lote.slice(0, match.index)
      return rowOuLote.lote
    }
    return ''
  }
  const loteCompleto = String(rowOuLote)
  const match = loteCompleto.match(/-(INS|EMB)-\d+$/)
  if (match) return loteCompleto.slice(0, match.index)
  return loteCompleto
}

const extrairLoteMP = (rowOuLote) => {
  if (!rowOuLote) return ''
  if (typeof rowOuLote === 'object') {
    if (rowOuLote.lote_externo) return rowOuLote.lote_externo
    if (rowOuLote.loteExterno) return rowOuLote.loteExterno
    if (Array.isArray(rowOuLote.lotes_externos) && rowOuLote.lotes_externos.length > 0) {
      return rowOuLote.lotes_externos[0]
    }
    if (typeof rowOuLote.lote === 'string') {
      return extrairLoteMP(rowOuLote.lote)
    }
    return ''
  }
  const loteStr = String(rowOuLote)
  const partes = loteStr.split('-').filter(Boolean)
  const partesNumericas = partes.filter((p) => /^\d+$/.test(p))
  if (!partesNumericas.length) return ''
  return partesNumericas.reduce((maior, atual) => (atual.length > maior.length ? atual : maior), partesNumericas[0])
}

const buildQrCodePaletePayload = ({
  idPalete,
  codigoProduto,
  descricao,
  cliente,
  pedido,
  quantidade,
  lote,
  material,
  maquina,
  fifo,
  dataProducao,
  tipo,
  status
}) => JSON.stringify({
  id: idPalete,
  codigo_produto: codigoProduto,
  descricao,
  cliente,
  pedido,
  quantidade,
  unidade: 'PC',
  lote,
  material,
  maquina,
  fifo,
  data_producao: dataProducao,
  tipo,
  status
})

// Tabela ABNT NBR 5426 S3 - Nível de Inspeção S3 (Reduzido)
// Retorna o tamanho da amostra baseado no tamanho do lote
const getTamanhAmostraNBRS3 = (tamanhoLote) => {
  const lote = Number(tamanhoLote) || 0
  
  // Tabela NBR 5426 S3 - Nível de Inspeção Reduzido
  if (lote < 3) return lote
  if (lote < 9) return 2
  if (lote < 16) return 3
  if (lote < 26) return 5
  if (lote < 51) return 8
  if (lote < 91) return 13
  if (lote < 151) return 20
  if (lote < 281) return 32
  if (lote < 501) return 50
  if (lote < 1201) return 80
  if (lote < 3201) return 125
  if (lote < 10001) return 200
  if (lote < 35001) return 315
  if (lote < 150001) return 500
  if (lote < 500001) return 800
  return 1250 // Lotes acima de 500.000
}

const copyToClipboard = async (text) => {
  try { await navigator.clipboard.writeText(text); alert('Copiado para a área de transferência:\n' + text) }
  catch { alert('Não foi possível copiar para a área de transferência.') }
}

const formatDateTimeBR = (value) => {
  if (!value) return ''
  try {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('pt-BR')
  } catch {
    return String(value)
  }
}

const sanitizeSheetName = (name) => {
  if (!name) return 'Dados'
  const sanitized = String(name).replace(/[:\\\/\?\*\[\]]/g, '').trim()
  return (sanitized || 'Dados').slice(0, 31)
}

// Funções auxiliares para extrair dados da ferramenta
const extrairFerramenta = (produto) => {
  if (!produto) return ''
  const s = String(produto).toUpperCase()
  const re3 = /^([A-Z]{3})([A-Z0-9]+)/
  const re2 = /^([A-Z]{2})([A-Z0-9]+)/
  let m = s.match(re3)
  if (m) return m[1]
  m = s.match(re2)
  if (m) return m[1]
  return ''
}

const extrairComprimentoAcabado = (produto) => {
  if (!produto) return ''
  const s = String(produto).toUpperCase()
  const re = /(\d{3,4})N?$/
  const m = s.match(re)
  return m ? m[1] : ''
}

const normalizePdfBaseAndFile = (basePath, fileName) => {
  let base = String(basePath || '').trim().replace(/^[\s\"]+|[\s\"]+$/g, '')
  base = base.replace(/[\\/]+$/, '')
  let file = String(fileName || '').trim()

  if (base && base.toLowerCase().endsWith('.pdf')) {
    const parts = base.split(/[\\/]/).filter(Boolean)
    const last = parts.length > 0 ? parts[parts.length - 1] : ''
    if (last) file = last
    parts.pop()
    base = parts.join('\\')
  }

  if (file && !file.toLowerCase().endsWith('.pdf')) file = `${file}.pdf`
  return { base, file }
}

// Constrói URL local file:///U:/... para abrir direto no navegador
const buildLocalFileUrl = (basePath, fileName) => {
  const safeBase = String(basePath || '').replace(/[\\/]+$/, '')
  const safeFile = String(fileName || '')
  const full = `${safeBase}\\${safeFile}`
  const asSlash = full.replace(/\\/g, '/')
  return `file:///${asSlash}`
}

// Abre uma URL em nova aba; se o navegador bloquear file:///, copia o caminho e alerta o usuário
const tryOpenInNewTab = async (url, fallbackPathText) => {
  try {
    const w = window.open(url, '_blank', 'noopener,noreferrer')
    // Alguns navegadores retornam null quando bloqueiam a abertura
    if (!w || w.closed || typeof w.closed === 'undefined') {
      if (fallbackPathText) {
        try { await navigator.clipboard.writeText(fallbackPathText) } catch {}
      }
      alert('O navegador bloqueou a abertura direta do arquivo local. O caminho foi copiado para a área de transferência. Cole no Explorer para abrir:\n' + (fallbackPathText || url))
    }
  } catch (e) {
    if (fallbackPathText) {
      try { await navigator.clipboard.writeText(fallbackPathText) } catch {}
    }
    alert('Não foi possível abrir o arquivo. Caminho copiado para a área de transferência:\n' + (fallbackPathText || url))
  }
}

const ApontamentosUsinagem = ({ tituloPagina = 'Apontamentos de Usinagem', subtituloForm = 'Novo Apontamento', modo = 'usinagem' }) => {
  const navigate = useNavigate()
  const { user } = useAuth() // Obtendo o usuário logado
  const somenteVisualizacao = isVisualizador(user)
  const { items: pedidosDB, loading: carregandoPedidos } = useSupabase('pedidos')
  const { items: apontamentosDB, addItem: addApont, loadItems: recarregarApontamentos } = useSupabase('apontamentos')
  const { items: statusApontamentosDB, addItem: addStatusApont, updateItem: updateStatusApont, loadItems: recarregarStatusApontamentos } = useSupabase('status_apontamentos')
  const [metaDiariaRitmo, setMetaDiariaRitmo] = useState(20000)
  const [turnosRitmo, setTurnosRitmo] = useState([])

  // Carregar meta e turnos do Supabase/localStorage para o painel de ritmo
  useEffect(() => {
    ;(async () => {
      try {
        const cfg = await supabaseService.obterConfiguracao('previsao_produtividade')
        const obj = cfg ? (typeof cfg === 'string' ? JSON.parse(cfg) : cfg) : null
        if (obj?.estimativaPcsPorDia > 0) setMetaDiariaRitmo(obj.estimativaPcsPorDia)
      } catch {}
      try {
        const tc = await supabaseService.obterConfiguracao('previsao_turnos')
        const arr = tc ? (typeof tc === 'string' ? JSON.parse(tc) : tc) : null
        if (Array.isArray(arr) && arr.length) setTurnosRitmo(arr)
      } catch {}
    })()
  }, [])
  const { items: paradasDB } = useSupabase('apontamentos_parada')
  const { items: kitsDB } = useSupabase('expedicao_kits')
  const { items: kitComponentesDB } = useSupabase('expedicao_kit_componentes')
  const { items: ferramentasCfg, loadItems: recarregarFerramentasCfg } = useSupabase('ferramentas_cfg')
  const { items: documentosFerramentas } = useSupabase('documentos_ferramentas')
  // Lotes importados (Dados • Lotes) via Supabase
  const { items: lotesDB } = useSupabase('lotes')
  
  // Debug: verificar se user está sendo carregado corretamente
  useEffect(() => {
    console.log('🔍 DEBUG ApontamentosUsinagem - User:', user)
    console.log('🔍 DEBUG ApontamentosUsinagem - nivel_acesso:', user?.nivel_acesso)
    console.log('🔍 DEBUG ApontamentosUsinagem - role:', user?.role)
    console.log('🔍 DEBUG ApontamentosUsinagem - isAdmin check:', user?.nivel_acesso === 'admin' || user?.nivel_acesso === 'Administrador')
  }, [user])
  
  // Helper para verificar se é admin
  const isAdmin = () => {
    const nivel = String(user?.nivel_acesso ?? user?.role ?? '').trim().toLowerCase()
    const isAdminCheck = nivel === 'admin' || nivel === 'administrador'
    console.log('🔍 isAdmin() called - result:', isAdminCheck, 'nivel(normalizado):', nivel)
    return isAdminCheck
  }
  
  // Filtro de prioridades
  const [filtrarPrioridades, setFiltrarPrioridades] = useState(false)
  const [pedidosPrioritarios, setPedidosPrioritarios] = useState(new Set())
  
  // Modal de correção de apontamentos
  const [apontamentoParaCorrigir, setApontamentoParaCorrigir] = useState(null)
  
  // Carregar prioridades do PCP
  useEffect(() => {
    carregarPrioridades()
  }, [])

  const carregarPrioridades = async () => {
    try {
      const prioridadesData = await supabaseService.getAll('pcp_prioridades')
      const setPrioritarios = new Set(
        (prioridadesData || [])
          .map(p => p.pedido_numero)
          .filter(Boolean)
      )
      setPedidosPrioritarios(setPrioritarios)
    } catch (error) {
      console.warn('Não foi possível carregar prioridades do PCP:', error)
      setPedidosPrioritarios(new Set())
    }
  }

  // Apontamento rápido de peça morta (refugo imediato)
  const handleSalvarPecaMorta = async (e) => {
    e?.preventDefault?.()
    if (!formData.ordemTrabalho) {
      alert('Selecione um Pedido/Seq antes de apontar peça morta.')
      return
    }
    if (!formData.codigoPerfil) {
      alert('Selecione o produto antes de apontar peça morta.')
      return
    }
    const qtd = Number(pecaMortaQtd || 0)
    if (!Number.isFinite(qtd) || qtd <= 0) {
      alert('Informe uma quantidade válida para peça morta.')
      return
    }
    if (!pecaMortaMotivo && !String(pecaMortaTexto || '').trim()) {
      alert('Informe o motivo (selecione ou escreva).')
      return
    }
    const nowIso = new Date().toISOString()
    const obsPecaMorta = `[Peça morta] Motivo: ${pecaMortaMotivo || 'texto'}${pecaMortaTexto ? ' | ' + pecaMortaTexto : ''}`
    const expFields = (modo === 'embalagem')
      ? { exp_unidade: 'embalagem', exp_stage: 'para-embarque', etapa_embalagem: formData.etapaEmbalagem || null }
      : { exp_unidade: 'usinagem' }
    const loteVinculado = (formData.lotesExternos && formData.lotesExternos[0]) ? formData.lotesExternos[0] : (formData.loteExterno || '')
    try {
      setPecaMortaSaving(true)
      await supabaseService.add('apontamentos', {
        operador: formData.operador || (user ? user.nome : ''),
        maquina: formData.maquina || '',
        produto: formData.codigoPerfil || '',
        cliente: formData.cliente || '',
        pedido_cliente: formData.pedidoCliente || '',
        ordem_trabalho: formData.ordemTrabalho || '',
        pedido_seq: formData.ordemTrabalho || '',
        nro_op: formData.nroOp || '',
        perfil_longo: formData.perfilLongo || '',
        inicio: nowIso,
        fim: nowIso,
        quantidade: 0,
        qtd_refugo: qtd,
        comprimento_refugo: Number(formData.comprimentoAcabado || 0) || null,
        qtd_pedido: formData.qtdPedido ? Number(formData.qtdPedido) : null,
        lote: loteVinculado || null,
        observacoes: obsPecaMorta,
        ...expFields
      })
      await recarregarApontamentos()
      setPecaMortaAberto(false)
      setPecaMortaQtd('')
      setPecaMortaMotivo('')
      setPecaMortaTexto('')
    } catch (err) {
      console.error('Erro ao salvar peça morta:', err)
      alert('Falha ao salvar peça morta')
    } finally {
      setPecaMortaSaving(false)
    }
  }

  const imprimirEtiquetasTermicasEmLote = async ({ lote, dist, rackOuPalletValor, dureza, loteMP }) => {
    const impressoraTermica = getConfiguracaoImpressoras().termica

    if (!isImpressoraAtiva('termica')) {
      alert(`Impressora térmica não está configurada ou ativa.\nVá em Configurações > Impressoras para configurar.`)
      return
    }

    if (!impressoraTermica?.ip) {
      alert('Impressora térmica sem IP configurado. Vá em Configurações > Impressoras e preencha o IP.')
      return
    }

    const cliente = formData.cliente || ''
    const pedidoSeq = formData.ordemTrabalho || ''
    const perfil = formData.codigoPerfil || ''
    const comprimentoRaw = formData.comprimentoAcabado || ''
    const comprimento = String(comprimentoRaw || '').replace(/[^0-9]/g, '')
    const pedidoCliente = formData.pedidoCliente || ''
    const durezaVal = (dureza && String(dureza).trim()) ? dureza : 'N/A'
    const loteMPVal = loteMP || formData.loteExterno || (formData.lotesExternos && formData.lotesExternos.length ? formData.lotesExternos[0] : '')

    const extrairFerramenta = (prod) => {
      if (!prod) return ''
      const s = String(prod).toUpperCase()
      const re3 = /^([A-Z]{3})([A-Z0-9]+)/
      const re2 = /^([A-Z]{2})([A-Z0-9]+)/
      let letras = '', resto = '', qtdDigitos = 0
      let m = s.match(re3)
      if (m) { letras = m[1]; resto = m[2]; qtdDigitos = 3 }
      else { m = s.match(re2); if (m) { letras = m[1]; resto = m[2]; qtdDigitos = 4 } else return '' }
      let nums = ''
      for (const ch of resto) {
        if (/[0-9]/.test(ch)) nums += ch
        else if (ch === 'O') nums += '0'
        if (nums.length === qtdDigitos) break
      }
      if (nums.length < qtdDigitos) nums = nums.padEnd(qtdDigitos, '0')
      return `${letras}-${nums}`
    }

    const ferramenta = extrairFerramenta(perfil)

    const totalEtiquetas = (dist || []).reduce((acc, d) => acc + (Number(d.qtdEtiquetas) || 0), 0)
    if (!totalEtiquetas) {
      alert('Nenhuma etiqueta para imprimir.')
      return
    }

    let seq = 1
    const etiquetasParaImprimir = []
    for (const d of (dist || [])) {
      const qtdEtiquetas = Number(d.qtdEtiquetas) || 0
      for (let i = 0; i < qtdEtiquetas; i++) {
        etiquetasParaImprimir.push({
          lote,
          loteMP: loteMPVal || '',
          rack: rackOuPalletValor || '',
          qtde: String(d.qtdPorEtiqueta || ''),
          ferramenta,
          dureza: durezaVal,
          numeroEtiqueta: seq,
          totalEtiquetas,
          codigoProdutoCliente: formData.codigoProdutoCliente || '',
          nomeCliente: cliente || '',
          comprimento: comprimento || '',
          pedidoCliente,
          pedidoSeq
        })
        seq += 1
      }
    }

    const tspl = PrintService.gerarMultiplasEtiquetas(etiquetasParaImprimir)

    try {
      await PrintService.enviarTspl({
        tipo: impressoraTermica.tipo || 'local_print_service',
        ip: impressoraTermica.ip || '',
        porta: Number(impressoraTermica.porta || 9100),
        portaCom: impressoraTermica.portaCom || '',
        caminhoCompartilhada: impressoraTermica.caminhoCompartilhada || '',
        nomeImpressora: impressoraTermica.nomeImpressora || impressoraTermica.nome || 'TSC TE200',
        tspl
      })
    } catch (err) {
      const destino = impressoraTermica.tipo === 'usb_com'
        ? impressoraTermica.portaCom
        : impressoraTermica.tipo === 'compartilhada_windows'
        ? impressoraTermica.caminhoCompartilhada
        : `${impressoraTermica.ip}:${impressoraTermica.porta || 9100}`
      alert(`Falha ao imprimir na TSC (${destino}).\nDetalhes: ${err?.message || 'erro desconhecido'}`)
      throw err
    }
  }

  const STORAGE_KEY = modo === 'embalagem' ? 'apont_embalagem_draft' : 'apont_usinagem_draft'
  const [formData, setFormData] = useState({
    operador: user ? user.nome : '',
    maquina: '',
    processoEmbalagem: 'somente_embalagem',
    etapaEmbalagem: 'EMBALAGEM',
    codigoPerfil: '',
    ordemTrabalho: '',
    inicio: '',
    fim: '',
    quantidade: '',
    qtdPedido: 0,
    perfilLongo: '',
    separado: '',
    cliente: '',
    pedidoCliente: '',
    dtFatura: '',
    unidade: '',
    comprimentoAcabado: '',
    nroOp: '',
    observacoes: '',
    romaneioNumero: '',
    loteExterno: '', // compat: primeiro lote
    lotesExternos: [], // novo: lista de lotes
    codigoProdutoCliente: '', // novo: código do produto do cliente
    rack_acabado: '' // novo: rack do produto acabado
  })

  // Estados do contador de tempo
  const [timerOn, setTimerOn] = useState(false)
  const [timerStart, setTimerStart] = useState(null) // Date
  const [nowTick, setNowTick] = useState(Date.now())

  // Estado para modal de inspeção de qualidade
  const [inspecaoAberta, setInspecaoAberta] = useState(false)
  const [apontamentoParaInspecao, setApontamentoParaInspecao] = useState(null)

  // Estado para seletor de tamanho de etiqueta
  const [tamanhoEtiqueta, setTamanhoEtiqueta] = useState('100x45')

  // Estado para modal de edição de pcs/Palete
  const [modalSenhaPcsPalete, setModalSenhaPcsPalete] = useState(false)
  const [modalEditarPcsPalete, setModalEditarPcsPalete] = useState(false)
  const [senhaAdmin, setSenhaAdmin] = useState('')
  const [novoPcsPalete, setNovoPcsPalete] = useState('')
  const [novoPcsAmarrado, setNovoPcsAmarrado] = useState('')

  // Função para validar senha do administrador
  const handleValidarSenhaPcsPalete = async () => {
    try {
      // Obter usuário atual do banco para validar senha
      const usuarios = await supabaseService.getByIndex('usuarios', 'email', user?.email)
      if (!usuarios || usuarios.length === 0) {
        alert('Erro ao validar senha.')
        return
      }
      const usuario = usuarios[0]
      
      // Validar senha (texto plano em dev)
      const senhaCorreta = usuario.senha === senhaAdmin || usuario.senha_hash === senhaAdmin
      if (!senhaCorreta) {
        alert('Senha incorreta.')
        return
      }

      // Senha válida, abrir modal de edição
      setModalSenhaPcsPalete(false)
      setModalEditarPcsPalete(true)
      
      // Preencher valores atuais
      const pcsAtual = Number(String(estatisticasProduto.pcsPorPalete || '0').replace(/\D/g, '')) || 0
      setNovoPcsPalete(pcsAtual.toString())
      const pcsAmarradoAtual = Number(estatisticasProduto.pcsPorAmarrado || 0)
      setNovoPcsAmarrado(pcsAmarradoAtual > 0 ? pcsAmarradoAtual.toString() : '')
    } catch (error) {
      alert('Erro ao validar senha: ' + String(error?.message || error))
    }
  }

  // Função para salvar novo valor pcs/Palete
  const handleSalvarNovoPcsPalete = async () => {
    try {
      const novoValor = parseInt(novoPcsPalete) || 0
      if (novoValor <= 0) {
        alert('O valor deve ser maior que zero.')
        return
      }

      // Obter configuração atual do produto usando a mesma lógica de extração de ferramentas_cfg
      const cfgs = await supabaseService.getAll('ferramentas_cfg')
      const extrairFerramenta = (produto) => {
        if (!produto) return ''
        const s = String(produto).toUpperCase()
        const re3 = /^([A-Z]{3})([A-Z0-9]+)/
        const re2 = /^([A-Z]{2})([A-Z0-9]+)/
        let letras = '', resto = '', qtdDigitos = 0
        let m = s.match(re3)
        if (m) { letras = m[1]; resto = m[2]; qtdDigitos = 3 }
        else { m = s.match(re2); if (!m) return ''; letras = m[1]; resto = m[2]; qtdDigitos = 4 }
        let nums = ''
        for (const ch of resto) {
          if (/[0-9]/.test(ch)) nums += ch
          else if (ch === 'O') nums += '0'
          if (nums.length === qtdDigitos) break
        }
        if (nums.length < qtdDigitos) nums = nums.padEnd(qtdDigitos, '0')
        return `${letras}-${nums}`
      }
      const ferramentaProduto = extrairFerramenta(formData.codigoPerfil || formData.produto)
      const comprimentoProduto = String(formData.comprimentoAcabado || '').replace(/\D/g, '')
      const comprimentoNormalizado = comprimentoProduto ? String(parseInt(comprimentoProduto, 10)) : ''
      const cfgAtual = cfgs.find(item => {
        const ferramentaCfg = String(item?.ferramenta || '').toUpperCase()
        if (ferramentaCfg !== String(ferramentaProduto || '').toUpperCase()) return false
        const comprimentoCfg = String(item?.comprimento_mm || item?.comprimento || '').replace(/\D/g, '')
        if (!comprimentoNormalizado) return true
        return comprimentoCfg ? String(parseInt(comprimentoCfg, 10)) === comprimentoNormalizado : true
      }) || null

      if (!cfgAtual) {
        alert('Configuração do produto não encontrada.')
        return
      }

      // Determinar campo correto baseado no tipo de embalagem
      const isCaixa = cfgAtual.embalagem === 'caixa'
      const campoAtualizar = isCaixa ? 'pcs_por_caixa' : 'pcs_por_pallet'

      // Atualizar configuração
      const updateData = {
        ...cfgAtual,
        [campoAtualizar]: novoValor
      }
      const novoAmarrado = parseInt(novoPcsAmarrado) || 0
      if (novoAmarrado > 0) {
        updateData.pecas_por_amarrado = novoAmarrado
      }
      await supabaseService.update('ferramentas_cfg', updateData)

      alert(`Valor atualizado para ${novoValor} pcs/${estatisticasProduto.tipoEmbalagem}${novoAmarrado > 0 ? ` e ${novoAmarrado} pcs/Amarrado` : ''}`)
      setModalEditarPcsPalete(false)
      
      // Recarregar configurações
      recarregarFerramentasCfg()
    } catch (error) {
      alert('Erro ao salvar: ' + String(error?.message || error))
    }
  }

  // Tick do relógio quando ligado
  useEffect(() => {
    if (!timerOn) return
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [timerOn])

  // Inicia o contador, sempre usando o horário atual como início
  const handleStartTimer = () => {
    if (!formData.ordemTrabalho) {
      alert('Selecione um Pedido/Seq antes de iniciar o contador.')
      return
    }
    const agora = new Date()
    const startInput = getNowLocalInput()
    setFormData(prev => ({ ...prev, inicio: startInput }))
    setTimerStart(agora)
    setTimerOn(true)
  }

  // Gera o código de lote: Data (DDMMYYYY) + Hora/Min (HHMM) + Romaneio + Lote Externo + Pedido.Cliente + Nº OP
  const gerarCodigoLote = () => {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const dia = pad(d.getDate())
    const mes = pad(d.getMonth() + 1)
    const ano = String(d.getFullYear())
    const data = `${dia}${mes}${ano}`
    const hora = pad(d.getHours())
    const min = pad(d.getMinutes())
    const hm = `${hora}${min}`
    const rom = (formData.romaneioNumero || '').toString().trim().replace(/\s+/g, '')
    const loteExt = (formData.lotesExternos && formData.lotesExternos.length > 0 ? formData.lotesExternos[0] : formData.loteExterno || '').toString().trim().replace(/\s+/g, '')
    const pedCli = (formData.pedidoCliente || '').toString().trim().replace(/\s+/g, '')
    const nro = (formData.nroOp || '').toString().trim().replace(/\s+/g, '')
    const base = `${data}-${hm}-${rom}-${loteExt}-${pedCli}-${nro}`
    return base.replace(/[^A-Za-z0-9_-]/g, '-')
  }

  // Cria etiqueta térmica (100x45mm ou 100x150mm) para impressora térmica
  const imprimirEtiquetaTermica = async (lote, quantidade, rackOuPalletValor, dureza, loteMP, numeroEtiqueta, totalEtiquetas) => {
    // Verificar configuração da impressora térmica
    const impressoraTermica = getConfiguracaoImpressoras().termica
    
    if (!isImpressoraAtiva('termica')) {
      alert(`Impressora térmica não está configurada ou ativa.\nVá em Configurações > Impressoras para configurar.`)
      return
    }
    
    const caminhoImpressora = getCaminhoImpressora('termica')
    console.log(`🖨️ Imprimindo etiqueta ${tamanhoEtiqueta} via: ${impressoraTermica.nome} (${caminhoImpressora})`)
    
    const cliente = formData.cliente || ''
    const pedidoSeq = formData.ordemTrabalho || ''
    const perfil = formData.codigoPerfil || ''
    const comprimentoRaw = formData.comprimentoAcabado || ''
    const comprimento = String(comprimentoRaw || '').replace(/[^0-9]/g, '')
    const pedidoCliente = formData.pedidoCliente || ''
    const qtde = quantidade || ''
    const pallet = rackOuPalletValor || ''
    const durezaVal = (dureza && String(dureza).trim()) ? dureza : 'N/A'
    const durezaDisplay = durezaVal
    const loteMPVal = loteMP || formData.loteExterno || (formData.lotesExternos && formData.lotesExternos.length ? formData.lotesExternos[0] : '')
    const loteMPDisplay = loteMPVal || 'MP não informado'
    
    // Extrai ferramenta do código do produto
    const extrairFerramenta = (prod) => {
      if (!prod) return ''
      const s = String(prod).toUpperCase()
      const re3 = /^([A-Z]{3})([A-Z0-9]+)/
      const re2 = /^([A-Z]{2})([A-Z0-9]+)/
      let letras = '', resto = '', qtdDigitos = 0
      let m = s.match(re3)
      if (m) { letras = m[1]; resto = m[2]; qtdDigitos = 3 }
      else { m = s.match(re2); if (m) { letras = m[1]; resto = m[2]; qtdDigitos = 4 } else return '' }
      let nums = ''
      for (const ch of resto) {
        if (/[0-9]/.test(ch)) nums += ch
        else if (ch === 'O') nums += '0'
        if (nums.length === qtdDigitos) break
      }
      if (nums.length < qtdDigitos) nums = nums.padEnd(qtdDigitos, '0')
      return `${letras}-${nums}`
    }
    
    const ferramenta = extrairFerramenta(perfil)

    if (!impressoraTermica?.ip) {
      alert('Impressora térmica sem IP configurado. Vá em Configurações > Impressoras e preencha o IP.')
      return
    }

    let tspl
    
    if (tamanhoEtiqueta === '100x150') {
      // Gerar etiqueta de palete 100x150mm
      const barcodeData = `${perfil || 'SC'}-${pallet || 'SR'}-${qtde || '0'}`
      tspl = PrintService.gerarEtiquetaPaleteTspl({
        larguraEtiquetaMm: 100,
        alturaEtiquetaMm: 150,
        gapEtiquetaMm: Number(impressoraTermica.gapEtiquetaMm ?? 3),
        idPalete: `${lote}-${numeroEtiqueta}`,
        codigoProduto: perfil,
        descricao: `${ferramenta} - ${comprimento}mm`,
        cliente,
        codigoCliente: formData.codigoProdutoCliente || '',
        pedido: pedidoSeq,
        quantidade: qtde,
        lote,
        loteMP: loteMPVal || '',
        rack: pallet,
        material: '6060-T6',
        maquina: formData.maquina || '',
        operador: formData.operador || '',
        dataProducao: new Date().toLocaleDateString('pt-BR'),
        qrCode: '',
        tipo: 'USINADO',
        fifo: 'ÁREA A',
        dureza: durezaDisplay,
        status: 'PRODUZIDO'
      })
    } else {
      // Gerar etiqueta padrão 100x45mm
      tspl = PrintService.gerarEtiquetaTspl({
        larguraEtiquetaMm: 100,
        alturaEtiquetaMm: 45,
        gapEtiquetaMm: Number(impressoraTermica.gapEtiquetaMm ?? 3),
        lote,
        loteMP: loteMPVal || '',
        rack: pallet,
        qtde,
        ferramenta,
        dureza: durezaDisplay,
        numeroEtiqueta,
        totalEtiquetas,
        codigoProdutoCliente: formData.codigoProdutoCliente || '',
        nomeCliente: cliente || '',
        comprimento: comprimento || '',
        pedidoCliente,
        pedidoSeq
      })
    }

    try {
      await PrintService.enviarTspl({
        tipo: impressoraTermica.tipo || 'local_print_service',
        ip: impressoraTermica.ip || '',
        porta: Number(impressoraTermica.porta || 9100),
        portaCom: impressoraTermica.portaCom || '',
        caminhoCompartilhada: impressoraTermica.caminhoCompartilhada || '',
        nomeImpressora: impressoraTermica.nomeImpressora || impressoraTermica.nome || 'TSC TE200',
        tspl
      })
    } catch (err) {
      const destino = impressoraTermica.tipo === 'usb_com' 
        ? impressoraTermica.portaCom 
        : impressoraTermica.tipo === 'compartilhada_windows'
        ? impressoraTermica.caminhoCompartilhada
        : `${impressoraTermica.ip}:${impressoraTermica.porta || 9100}`
      alert(`Falha ao imprimir na TSC (${destino}).\nDetalhes: ${err?.message || 'erro desconhecido'}`)
      throw err
    }
  }

  // Cria conteúdo HTML estilizado para o formulário e dispara download .doc
  const imprimirDocumentoIdentificacao = (lote, quantidade, rackOuPalletValor, dureza, loteMP) => {
    const cliente = formData.cliente || ''
    const item = formData.codigoPerfil || ''
    const codigoCliente = formData.codigoProdutoCliente || ''
    const medida = formData.comprimentoAcabado ? `${formData.comprimentoAcabado} mm` : extrairComprimentoAcabado(item)
    const pedidoTecno = formData.ordemTrabalho || ''
    const pedidoCli = formData.pedidoCliente || ''
    const qtde = quantidade || ''
    const pallet = formData.rack_acabado || rackOuPalletValor || ''
    const durezaVal = dureza || ''
    const loteMPVal = loteMP || ''
    const dataHoraProducao = formData.inicio ? parseLocalInputToDate(formData.inicio) : null
    const dataProducao = dataHoraProducao ? dataHoraProducao.toLocaleDateString('pt-BR') : ''
    const turno = formData.turno || calcularTurno(dataHoraProducao)

    const nomeKit = resolverNomeKit(item, kitsDB, kitComponentesDB)
    const html = buildFormularioIdentificacaoHtml({
      lote,
      loteMP: loteMPVal,
      cliente,
      item,
      codigoCliente,
      nomeKit,
      medida,
      pedidoTecno,
      pedidoCli,
      qtde,
      pallet,
      dureza: durezaVal,
      dataProducao,
      dataHoraProducao: dataHoraProducao ? dataHoraProducao.toISOString() : '',
      turno
    })
    
    // Abrir em nova janela pronta para impressão (mesmo método da reimpressão na expedição)
    const printWindow = window.open('', '_blank', 'width=1100,height=800')
    printWindow.document.write(html)
    printWindow.document.close()
    setTimeout(() => {
      printWindow.print()
    }, 500)
  }

  // Buscar apontamento por Rack Acabado para reimpressão
  const buscarRackParaReimpressao = async () => {
    const rack = String(reimpRackBusca || '').trim().toUpperCase()
    if (!rack) return

    const preencherForm = (encontrado) => {
      setReimpRackResultado(encontrado)
      setReimpRackForm({
        cliente: encontrado.cliente || '',
        produto: encontrado.produto || encontrado.codigoPerfil || '',
        comprimento_acabado_mm: encontrado.comprimento_acabado_mm || '',
        pedido_seq: encontrado.ordemTrabalho || encontrado.ordem_trabalho || encontrado.pedido_seq || '',
        pedido_cliente: encontrado.pedido_cliente || encontrado.pedidoCliente || '',
        quantidade: encontrado.quantidade || '',
        rack_acabado: encontrado.rack_acabado || encontrado.rackAcabado || '',
        dureza_material: encontrado.dureza_material || '',
        lote: encontrado.lote || '',
        lote_externo: encontrado.lote_externo || encontrado.loteExterno || '',
        codigo_produto_cliente: encontrado.codigo_produto_cliente || encontrado.codigoProdutoCliente || '',
      })
      setReimpRackEditando(false)
    }

    // Buscar nos apontamentos já carregados
    const encontrado = (apontamentosDB || []).find(a => {
      const rackAcab = String(a.rack_acabado || a.rackAcabado || '').trim().toUpperCase()
      return rackAcab === rack
    })

    if (encontrado) {
      preencherForm(encontrado)
      return
    }

    // Fallback: buscar diretamente no Supabase
    try {
      const resultado = await supabaseService.getByIndex('apontamentos', 'rack_acabado', rack)
      if (resultado && resultado.length > 0) {
        preencherForm(resultado[0])
        return
      }
    } catch (err) {
      console.error('Erro ao buscar rack no Supabase:', err)
    }

    setReimpRackResultado('NOT_FOUND')
    setReimpRackForm({})
  }

  const imprimirReimpRack = () => {
    const dados = reimpRackEditando ? reimpRackForm : { ...reimpRackResultado, ...reimpRackForm }
    const item = dados.produto || ''
    const medida = dados.comprimento_acabado_mm ? `${dados.comprimento_acabado_mm} mm` : extrairComprimentoAcabado(item)
    const dataHoraProducao = dados.inicio || dados.data_inicio || dados.data_inicio_producao || ''
    const dataProducao = dataHoraProducao ? new Date(dataHoraProducao).toLocaleDateString('pt-BR') : ''
    const turno = dados.turno || calcularTurno(dataHoraProducao)

    const nomeKit = resolverNomeKit(item, kitsDB, kitComponentesDB)
    const html = buildFormularioIdentificacaoHtml({
      lote: dados.lote || '',
      loteMP: dados.lote_externo || '',
      cliente: dados.cliente || '',
      item,
      codigoCliente: dados.codigo_produto_cliente || '',
      nomeKit,
      medida,
      pedidoTecno: dados.pedido_seq || '',
      pedidoCli: dados.pedido_cliente || '',
      qtde: dados.quantidade || '',
      pallet: dados.rack_acabado || '',
      dureza: dados.dureza_material || 'N/A',
      dataProducao,
      dataHoraProducao,
      turno
    })

    const printWindow = window.open('', '_blank', 'width=1100,height=800')
    printWindow.document.write(html)
    printWindow.document.close()
    setTimeout(() => { printWindow.print() }, 500)
  }

  // Finaliza o contador e pergunta se usa o tempo no apontamento
  const handleStopTimer = () => {
    const end = new Date()
    const start = timerStart || parseLocalInputToDate(formData.inicio)
    if (!start) {
      setTimerOn(false)
      setTimerStart(null)
      return
    }
    const diffMin = Math.round((end - start) / 60000)
    const msg = `Deseja utilizar este tempo no apontamento?\n\nInício: ${start.toLocaleString('pt-BR')}\nFim: ${end.toLocaleString('pt-BR')}\nTempo: ${diffMin} minuto(s).`
    const ok = window.confirm(msg)
    if (ok) {
      // Atualiza o campo 'Fim' com o horário atual no formato datetime-local
      const pad = (n) => String(n).padStart(2, '0')
      const Y = end.getFullYear()
      const M = pad(end.getMonth() + 1)
      const D = pad(end.getDate())
      const H = pad(end.getHours())
      const Min = pad(end.getMinutes())
      const endInput = `${Y}-${M}-${D}T${H}:${Min}`
      setFormData(prev => ({ ...prev, fim: endInput }))
    }
    setTimerOn(false)
    setTimerStart(null)
  }
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [buscaAberta, setBuscaAberta] = useState(false)
  const [buscaTexto, setBuscaTexto] = useState('')
  // Confirmação de apontamento
  const [confirmarAberto, setConfirmarAberto] = useState(false)
  const [qtdConfirmada, setQtdConfirmada] = useState('')
  const [rackOuPallet, setRackOuPallet] = useState('')
  const [qtdRefugo, setQtdRefugo] = useState('')
  const [materialLongoManual, setMaterialLongoManual] = useState('')
  const [matrizOrigemManual, setMatrizOrigemManual] = useState('')
  const [origemManual, setOrigemManual] = useState('')
  const [comprimentoRefugo, setComprimentoRefugo] = useState('')
  const [durezaMaterial, setDurezaMaterial] = useState('')
  const [finalizarRack, setFinalizarRack] = useState(true)
  const [editandoRack, setEditandoRack] = useState(false)
  // Modal de peça morta
  const [pecaMortaAberto, setPecaMortaAberto] = useState(false)
  const [pecaMortaQtd, setPecaMortaQtd] = useState('')
  const [pecaMortaMotivo, setPecaMortaMotivo] = useState('')
  const [pecaMortaTexto, setPecaMortaTexto] = useState('')
  const [pecaMortaSaving, setPecaMortaSaving] = useState(false)
  const motivosPecaMorta = ['Falha de processo', 'Erro operacional', 'Engano', 'Quebra de ferramenta', 'Outros']
  // Modal de listagem de apontamentos da ordem selecionada
  const [listarApontAberto, setListarApontAberto] = useState(false)
  const [tabelaDiariaAberta, setTabelaDiariaAberta] = useState(false)
  const [dataTabelaDiaria, setDataTabelaDiaria] = useState(() => new Date().toISOString().slice(0, 10))
  const [filtroTabelaDiaria, setFiltroTabelaDiaria] = useState('')
  const [turnoTabelaDiaria, setTurnoTabelaDiaria] = useState('')
  const [graficoParadasAberto, setGraficoParadasAberto] = useState(false)
  const [tipoParadaExpandido, setTipoParadaExpandido] = useState(null)
  const [statusLocalCache, setStatusLocalCache] = useState({})
  const [menuReimpressaoAberto, setMenuReimpressaoAberto] = useState(null)
  const [tipoReimpressao, setTipoReimpressao] = useState('formulario')
  const [reimpressaoDistribuicao, setReimpressaoDistribuicao] = useState([{ qtdPorEtiqueta: '', qtdEtiquetas: '1' }])
  // Modal de reimpressão por Rack Acabado
  const [reimpRackAberto, setReimpRackAberto] = useState(false)
  const [reimpRackBusca, setReimpRackBusca] = useState('')
  const [reimpRackResultado, setReimpRackResultado] = useState(null)
  const [reimpRackEditando, setReimpRackEditando] = useState(false)
  const [reimpRackForm, setReimpRackForm] = useState({})
  const [showTimerModal, setShowTimerModal] = useState(false)
  // Modal de visualização da foto da ferramenta
  const [fotoModalAberta, setFotoModalAberta] = useState(false)
  const [fotoUrlVisualizacao, setFotoUrlVisualizacao] = useState('')
  const fileInputRef = useRef(null)
  // Modal de pré-visualização da etiqueta
  const [etiquetaPreviewAberta, setEtiquetaPreviewAberta] = useState(false)
  const [apontamentoPreview, setApontamentoPreview] = useState(null)
  const [tipoPreview, setTipoPreview] = useState('etiquetas') // 'etiquetas' | 'etiqueta_palete'
  const [tipoPaleteManual, setTipoPaleteManual] = useState('USINADO')
  const [fifoPaleteManual, setFifoPaleteManual] = useState('ÁREA A')
  const [statusPaleteManual, setStatusPaleteManual] = useState('PRODUZIDO')
  const [exportDestination, setExportDestination] = useState('')
  const [exportQcStatus, setExportQcStatus] = useState('APPROVED')
  const [qrCodePaletePreviewUrl, setQrCodePaletePreviewUrl] = useState('')
  // Modal pós-sucesso: continuar no mesmo item?
  const [continuarMesmoItemAberto, setContinuarMesmoItemAberto] = useState(false)
  // Modal para imprimir formulário de identificação
  const [imprimirAberto, setImprimirAberto] = useState(false)
  const [perguntarFotoMontagem, setPerguntarFotoMontagem] = useState(true)
  const [ultimoLote, setUltimoLote] = useState('')
  const [ultimoApontamentoId, setUltimoApontamentoId] = useState('')
  const [tipoImpressao, setTipoImpressao] = useState('documento') // 'documento' | 'etiqueta'
  const [loteMPSelecionado, setLoteMPSelecionado] = useState('')
  const [etiquetasDistribuicao, setEtiquetasDistribuicao] = useState([{ qtdPorEtiqueta: '', qtdEtiquetas: '' }])
  // Modal para romaneio e lote externo (fluxo antigo – mantendo disponível se necessário)
  const [romaneioAberto, setRomaneioAberto] = useState(false)
  const [tmpRomaneio, setTmpRomaneio] = useState('')
  const [tmpLotesExt, setTmpLotesExt] = useState([''])
  // Modal de seleção de Rack!Embalagem e lotes (novo fluxo ao selecionar Pedido/Seq)
  const [rackModalAberto, setRackModalAberto] = useState(false)
  const [pedidoSeqSelecionado, setPedidoSeqSelecionado] = useState('')
  const [rackDigitado, setRackDigitado] = useState('')
  const [lotesEncontrados, setLotesEncontrados] = useState([]) // [{id?, lote}]
  const [lotesSelecionados, setLotesSelecionados] = useState([]) // [lote]
  const [amarradosSelecionadosRack, setAmarradosSelecionadosRack] = useState([]) // [{lote, codigo, ...}]
  const [lotesExpandidos, setLotesExpandidos] = useState([]) // [lote] - controla quais lotes estão expandidos
  // Digitar Lote de Extrusão manualmente
  const [manualAberto, setManualAberto] = useState(false)
  const [manualLotesTxt, setManualLotesTxt] = useState('')
  const FOTO_MONTAGEM_PREF_KEY = 'apontamentos_perguntar_foto_montagem_palete'

  useEffect(() => {
    try {
      if (typeof window === 'undefined') return
      const salvo = localStorage.getItem(FOTO_MONTAGEM_PREF_KEY)
      if (salvo === null) return
      setPerguntarFotoMontagem(salvo === 'true')
    } catch {}
  }, [])
  // Inspeção de amarrados do Rack
  const [inspAberto, setInspAberto] = useState(false)
  const [amarradosRack, setAmarradosRack] = useState([])
  const [amarradosSelecionados, setAmarradosSelecionados] = useState([]) // array de indices
  const [marcarTodosAmarrados, setMarcarTodosAmarrados] = useState(false)
  const [filtroPedidoInsp, setFiltroPedidoInsp] = useState('')
  const [filtroRomaneioInsp, setFiltroRomaneioInsp] = useState('')
  // Buscar por Amarrado (encontrar Rack/Embalagem pelo nº do amarrado)
  const [buscarAmarradoAberto, setBuscarAmarradoAberto] = useState(false)
  const [numeroAmarrado, setNumeroAmarrado] = useState('')
  const [resultadosAmarrado, setResultadosAmarrado] = useState([]) // [{rack, lote, produto, pedido_seq, romaneio, codigo, qt_kg, qtd_pc}]
  // Buscar Rack por Código do Produto
  const [buscarRackProdutoAberto, setBuscarRackProdutoAberto] = useState(false)
  const [codigoProdutoBusca, setCodigoProdutoBusca] = useState('')
  const [filtroFerramentaBusca, setFiltroFerramentaBusca] = useState('')
  const [filtroComprimentoBusca, setFiltroComprimentoBusca] = useState('')
  
  // Função para calcular duração em minutos
  const duracaoMin = (inicio, fim) => {
    if (!inicio || !fim) return null
    try {
      const di = new Date(inicio)
      const df = new Date(fim)
      if (isNaN(di.getTime()) || isNaN(df.getTime())) return null
      return Math.round((df - di) / 60000)
    } catch {
      return null
    }
  }

  // Estatísticas do produto atual para o painel de produtividade
  const estatisticasProduto = useMemo(() => {
    if (!formData.codigoPerfil) return null

    const extrairFerramentaLocal = (produto) => {
      if (!produto) return ''
      const s = String(produto).toUpperCase()
      const re3 = /^([A-Z]{3})([A-Z0-9]+)/
      const re2 = /^([A-Z]{2})([A-Z0-9]+)/
      let letras = ''
      let resto = ''
      let qtdDigitos = 0
      let m = s.match(re3)
      if (m) {
        letras = m[1]
        resto = m[2]
        qtdDigitos = 3
      } else {
        m = s.match(re2)
        if (!m) return ''
        letras = m[1]
        resto = m[2]
        qtdDigitos = 4
      }
      let nums = ''
      for (const ch of resto) {
        if (/[0-9]/.test(ch)) nums += ch
        else if (ch === 'O') nums += '0'
        if (nums.length === qtdDigitos) break
      }
      if (nums.length < qtdDigitos) nums = nums.padEnd(qtdDigitos, '0')
      return `${letras}-${nums}`
    }

    const ferramentaProduto = extrairFerramentaLocal(formData.codigoPerfil)
    const comprimentoProduto = String(formData.comprimentoAcabado || '').replace(/\D/g, '')
    const comprimentoNormalizado = comprimentoProduto ? String(parseInt(comprimentoProduto, 10)) : ''
    const itensCfg = Array.isArray(ferramentasCfg) ? ferramentasCfg : []
    const cfg = itensCfg.find(item => {
      const ferramentaCfg = String(item?.ferramenta || '').toUpperCase()
      if (ferramentaCfg !== String(ferramentaProduto || '').toUpperCase()) return false
      const comprimentoCfg = String(item?.comprimento_mm || item?.comprimento || '').replace(/\D/g, '')
      if (!comprimentoNormalizado) return true
      return comprimentoCfg ? String(parseInt(comprimentoCfg, 10)) === comprimentoNormalizado : true
    }) || null

    const pcsPorPalete = cfg?.embalagem === 'caixa' ? cfg?.pcs_por_caixa : cfg?.pcs_por_pallet
    const pcsPorAmarrado = Number(cfg?.pecas_por_amarrado || 0) || 0
    const tipoEmbalagem = cfg?.embalagem === 'caixa' ? 'Caixa' : 'Palete'
    const teoricoPcsHora = Number(cfg?.teorico_produtividade_pcs_hora || 0) || 0

    // Filtrar apontamentos do mesmo produto (limitado aos mais recentes para performance)
    const apontamentosProduto = (apontamentosDB || [])
      .filter(a => {
        const prod = a.produto || a.codigoPerfil
        return prod && String(prod).toUpperCase() === String(formData.codigoPerfil).toUpperCase()
      })
      .sort((a, b) => {
        const ta = a.inicio ? new Date(a.inicio).getTime() : 0
        const tb = b.inicio ? new Date(b.inicio).getTime() : 0
        return tb - ta // Descendente
      })

    // Calcular Pcs/h dos últimos apontamentos válidos
    const historicoProdutividade = []
    let somaProducao = 0
    let somaMinutos = 0

    for (const a of apontamentosProduto) {
      const min = duracaoMin(a.inicio, a.fim)
      const qtd = Number(a.quantidade || a.quantidadeProduzida || 0)
      if (min && min > 0 && qtd > 0) {
        const pcsH = Number((qtd / (min / 60)).toFixed(1))
        historicoProdutividade.unshift({ // unshift para ficar do mais antigo para o mais novo no gráfico
          data: new Date(a.inicio).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
          pcsH
        })
        somaProducao += qtd
        somaMinutos += min
      }
      if (historicoProdutividade.length >= 5) break // Pegar os últimos 5
    }

    const produtividadeMedia = somaMinutos > 0 ? (somaProducao / (somaMinutos / 60)).toFixed(1) : 0

    const formatarNumeroPainel = (valor) => {
      const num = Number(valor || 0)
      if (!Number.isFinite(num)) return '-'
      return num.toLocaleString('pt-BR', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
      })
    }

    const produtividadeMediaNum = Number(produtividadeMedia || 0)
    const diferencaTeorica = teoricoPcsHora > 0 ? (produtividadeMediaNum - teoricoPcsHora) : 0
    const comparativoStatus = teoricoPcsHora <= 0
      ? 'sem-meta'
      : produtividadeMediaNum > teoricoPcsHora
        ? 'acima'
        : produtividadeMediaNum < teoricoPcsHora
          ? 'abaixo'
          : 'igual'

    const pesoLinear = Number(cfg?.peso_linear || 0) || 0
    const comprimentoMm = Number(String(formData.comprimentoAcabado || '').replace(/\D/g, '') || 0) || 0
    const pcsPorPaleteNum = Number(pcsPorPalete || 0) || 0
    const kgPorPeça = pesoLinear > 0 && comprimentoMm > 0 ? (pesoLinear * comprimentoMm / 1000) : 0
    const kgPorPalete = pcsPorPaleteNum > 0 && kgPorPeça > 0 ? (pcsPorPaleteNum * kgPorPeça) : 0

    return {
      pcsPorPalete: pcsPorPalete ? formatarNumeroPainel(pcsPorPalete) : '-',
      pcsPorPaleteNum,
      tipoEmbalagem,
      produtividadeMedia: formatarNumeroPainel(produtividadeMedia),
      produtividadeMediaValor: produtividadeMediaNum,
      teoricoPcsHoraValor: teoricoPcsHora,
      teoricoPcsHora: teoricoPcsHora ? formatarNumeroPainel(teoricoPcsHora) : '-',
      diferencaTeorica: teoricoPcsHora ? formatarNumeroPainel(Math.abs(diferencaTeorica)) : '-',
      comparativoStatus,
      historico: historicoProdutividade,
      temHistorico: historicoProdutividade.length > 0,
      kgPorPalete: kgPorPalete > 0 ? kgPorPalete.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 1 }) : null,
      pcsPorAmarrado
    }
  }, [formData.codigoPerfil, formData.comprimentoAcabado, apontamentosDB, ferramentasCfg])

  // Extrai ferramenta do código do produto (ex: TG2012565508NANV -> TG-2012)
  const extrairFerramenta = (produto) => {
    if (!produto) return ''
    const s = String(produto).toUpperCase()
    const re3 = /^([A-Z]{3})([A-Z0-9]+)/
    const re2 = /^([A-Z]{2})([A-Z0-9]+)/
    let letras = ''
    let resto = ''
    let qtdDigitos = 0
    let m = s.match(re3)
    if (m) {
      letras = m[1]
      resto = m[2]
      qtdDigitos = 3
    } else {
      m = s.match(re2)
      if (m) {
        letras = m[1]
        resto = m[2]
        qtdDigitos = 4
      } else {
        return ''
      }
    }
    let nums = ''
    for (const ch of resto) {
      if (/[0-9]/.test(ch)) {
        nums += ch
      } else if (ch === 'O') {
        nums += '0'
      }
      if (nums.length === qtdDigitos) break
    }
    if (nums.length < qtdDigitos) {
      nums = nums.padEnd(qtdDigitos, '0')
    }
    return `${letras}-${nums}`
  }
  
  // Extrai o comprimento do acabado a partir do código do produto
  const extrairComprimentoAcabado = (produto) => {
    if (!produto) return ''
    const produtoStr = String(produto)
    const match = produtoStr.match(/(\d{3,4})([A-Z]{2,4})$/)
    return match ? match[1] : ''
  }

  const buscarCfgFerramenta = (produto) => {
    const ferramenta = extrairFerramenta(produto)
    const comprimento = String(extrairComprimentoAcabado(produto) || '').replace(/\D/g, '')
    const itensCfg = Array.isArray(ferramentasCfg) ? ferramentasCfg : []

    return itensCfg.find(item => {
      const ferramentaCfg = String(item?.ferramenta || '').toUpperCase().trim()
      if (ferramentaCfg !== String(ferramenta || '').toUpperCase().trim()) return false
      const comprimentoCfg = String(item?.comprimento_mm || item?.comprimento || '').replace(/\D/g, '')
      if (!comprimento) return true
      return comprimentoCfg ? String(parseInt(comprimentoCfg, 10)) === String(parseInt(comprimento, 10)) : true
    }) || itensCfg.find(item => String(item?.ferramenta || '').toUpperCase().trim() === String(ferramenta || '').toUpperCase().trim()) || null
  }

  const extrairComprimentoLongoMm = (produto) => {
    if (!produto) return ''
    const s = String(produto).trim().toUpperCase()
    const m = s.match(/(\d{4})(?=[A-Z]{2,4}$)/)
    const digits = m ? m[1] : ''
    if (!digits || !/^\d{4}$/.test(digits)) return ''
    const n = parseInt(digits, 10)
    if (!Number.isFinite(n)) return ''
    return `${n.toLocaleString('pt-BR')} mm`
  }
  
  // Busca em tempo real por código do Produto, Ferramenta e Comprimento
  const resultadosRackProduto = useMemo(() => {
    const codigoProd = String(codigoProdutoBusca || '').trim().toUpperCase()
    const ferramBusca = String(filtroFerramentaBusca || '').trim().toUpperCase()
    const compBusca = String(filtroComprimentoBusca || '').trim().toUpperCase()
    
    // Se nenhum filtro foi preenchido, retorna vazio
    if (!codigoProd && !ferramBusca && !compBusca) return []
    
    // Mínimo 2 caracteres em pelo menos um filtro
    const temFiltro = (codigoProd.length >= 2) || (ferramBusca.length >= 2) || (compBusca.length >= 1)
    if (!temFiltro) return []
    
    // Buscar todos os lotes que atendam aos critérios
    const lotesProduto = (lotesDB || []).filter(l => {
      const produto = String(l.produto || '').toUpperCase().trim()
      const ferramenta = extrairFerramenta(produto).toUpperCase()
      const comprimento = extrairComprimentoAcabado(produto).toUpperCase()
      
      // Aplicar filtros (AND lógico)
      if (codigoProd && !produto.includes(codigoProd)) return false
      if (ferramBusca && !ferramenta.includes(ferramBusca)) return false
      if (compBusca && !comprimento.includes(compBusca)) return false
      
      return produto.length > 0
    })
    
    // Agrupar por Rack/Embalagem
    const rackMap = new Map()
    for (const l of lotesProduto) {
      const rack = String(l.rack_embalagem || '').trim()
      if (!rack) continue
      
      if (!rackMap.has(rack)) {
        rackMap.set(rack, {
          rack,
          amarrados: [],
          romaneios: new Set(),
          produtos: new Set(),
          pedidos: new Set(),
          totalKg: 0,
          totalPc: 0
        })
      }
      
      const entry = rackMap.get(rack)
      entry.amarrados.push({
        codigo: String(l.codigo || '').trim(),
        lote: String(l.lote || '').trim(),
        produto: String(l.produto || '').trim(),
        pedido_seq: String(l.pedido_seq || '').trim(),
        romaneio: String(l.romaneio || '').trim()
      })
      
      // Somar Qt Kg e Qtd PC
      entry.totalKg += Number(l.qt_kg || 0)
      entry.totalPc += Number(l.qtd_pc || 0)
      
      const romaneio = String(l.romaneio || '').trim()
      if (romaneio) entry.romaneios.add(romaneio)
      
      const produto = String(l.produto || '').trim()
      if (produto) entry.produtos.add(produto)
      
      const pedidoSeq = String(l.pedido_seq || '').trim()
      if (pedidoSeq) entry.pedidos.add(pedidoSeq)
    }
    
    // Converter para array
    return Array.from(rackMap.values()).map(e => ({
      rack: e.rack,
      qtdAmarrados: e.amarrados.length,
      amarrados: e.amarrados,
      romaneios: Array.from(e.romaneios).join(', ') || '-',
      produtos: Array.from(e.produtos).slice(0, 3).join(', ') + (e.produtos.size > 3 ? '...' : ''),
      pedidos: Array.from(e.pedidos).slice(0, 3).join(', ') + (e.pedidos.size > 3 ? '...' : ''),
      totalKg: e.totalKg,
      totalPc: e.totalPc
    })).sort((a, b) => b.qtdAmarrados - a.qtdAmarrados)
  }, [codigoProdutoBusca, filtroFerramentaBusca, filtroComprimentoBusca, lotesDB])

  const [amarradosSelecionadosBusca, setAmarradosSelecionadosBusca] = useState([]) // indices dos amarrados selecionados na busca
  const [amarradosAcumulados, setAmarradosAcumulados] = useState([]) // todos os amarrados já selecionados nas buscas anteriores
  const amarradosFiltrados = useMemo(() => {
    const ped = String(filtroPedidoInsp || '').replace(/\D/g, '')
    const rom = String(filtroRomaneioInsp || '').replace(/\D/g, '')
    return amarradosRack.filter(a => {
      const pedOk = ped ? String(a.pedido_seq || '').replace(/\D/g, '').startsWith(ped) : true
      const romOk = rom ? String(a.romaneio || '').replace(/\D/g, '').startsWith(rom) : true
      return pedOk && romOk
    })
  }, [filtroPedidoInsp, filtroRomaneioInsp, amarradosRack])
  
  // Normaliza identificadores de Rack/Embalagem para números (remove tudo que não seja dígito)
  const normalizeRackId = (val) => {
    const s = String(val || '')
    const digits = s.replace(/\D/g, '')
    return digits
  }

  // Lê um campo do dados_originais do lote de forma case-insensitive
  const getCampoOriginalLote = (loteObj, campo) => {
    try {
      const dados = loteObj?.dados_originais || {}
      const alvo = String(campo).toLowerCase().replace(/[^a-z0-9]/g, '')
      for (const k of Object.keys(dados)) {
        const nk = String(k).toLowerCase().replace(/[^a-z0-9]/g, '')
        if (nk === alvo) return dados[k]
      }
      return ''
    } catch { return '' }
  }

  // Busca lotes na store 'lotes' conforme Rack informado (sem vincular ao Pedido/Seq neste momento)
  const buscarLotesPorRack = () => {
    const rack = String(rackDigitado || '').trim()
    if (!rack) { setLotesEncontrados([]); return }
    try {
      // Busca exata primeiro (como na versão que funcionava)
      let lista = (lotesDB || []).filter(l => String(l.rack_embalagem || '').trim() === rack)
      
      // Se não encontrou nada, tenta busca normalizada
      if (lista.length === 0) {
        const rackNorm = normalizeRackId(rack)
        if (rackNorm) {
          lista = (lotesDB || []).filter(l => {
            const lr = normalizeRackId(l.rack_embalagem)
            if (!lr) return false
            return lr === rackNorm || (lr.endsWith(rackNorm) && rackNorm.length >= 3)
          })
        }
      }
      
      // Agregar por número do lote, incluindo amarrados
      const map = new Map()
      for (const l of lista) {
        const num = String(l.lote || '').trim()
        if (!num) continue
        const pedidoSeq = String(l.pedido_seq || '').trim()
        const p = pedidoSeq.includes('/') ? pedidoSeq.split('/') : ['', '']
        const pedido = p[0] || ''
        const seq = p[1] || ''
        const produtoPlanilha = String(l.produto || getCampoOriginalLote(l, 'Produto') || l.codigo || '').trim()
        const ferramentaPlanilha = extrairFerramenta(produtoPlanilha || '')
        const comprimentoLongoMm = extrairComprimentoLongoMm(produtoPlanilha)
        const amarradoCodigo = String(l.codigo || getCampoOriginalLote(l, 'Amarrado') || '').trim()
        
        if (!map.has(num)) {
          map.set(num, {
            lote: num,
            produto: produtoPlanilha,
            ferramenta: ferramentaPlanilha,
            comprimentoLongoMm,
            romaneios: new Set(),
            pedido,
            seq,
            amarrados: []
          })
        }
        const entry = map.get(num)
        // Se em registros subsequentes houver produto não vazio, mantém o primeiro não vazio
        if (!entry.produto && produtoPlanilha) entry.produto = produtoPlanilha
        if (!entry.ferramenta && ferramentaPlanilha) entry.ferramenta = ferramentaPlanilha
        if (!entry.comprimentoLongoMm && comprimentoLongoMm) entry.comprimentoLongoMm = comprimentoLongoMm
        const rom = String(l.romaneio || '').trim()
        if (rom) entry.romaneios.add(rom)
        
        // Adicionar amarrado se não existir já
        if (amarradoCodigo && !entry.amarrados.some(a => a.codigo === amarradoCodigo)) {
          entry.amarrados.push({
            codigo: amarradoCodigo,
            rack: String(l.rack_embalagem || '').trim(),
            lote: num,
            produto: produtoPlanilha,
            pedido_seq: pedidoSeq,
            romaneio: rom,
            qt_kg: Number(l.qt_kg || 0),
            qtd_pc: Number(l.qtd_pc || 0),
            situacao: String(l.situacao || '').trim(),
            embalagem_data: l.embalagem_data || null,
            nota_fiscal: String(l.nota_fiscal || '').trim()
          })
        }
      }
      
      // Converter para array e mesclar romaneios únicos
      const unicos = Array.from(map.values()).map(e => ({
        lote: e.lote,
        produto: e.produto,
        ferramenta: e.ferramenta,
        comprimentoLongoMm: e.comprimentoLongoMm,
        romaneio: Array.from(e.romaneios).join(', '),
        pedido: e.pedido,
        seq: e.seq,
        amarrados: e.amarrados
      }))
      setLotesEncontrados(unicos)
      setLotesSelecionados(prev => prev.filter(v => unicos.some(x => x.lote === v)))
    } catch { setLotesEncontrados([]) }
  }

  // Busca o Rack/Embalagem a partir do número do Amarrado informado
  const procurarRackPorAmarrado = () => {
    const raw = String(numeroAmarrado || '').trim()
    const digits = raw.replace(/\D/g, '')
    if (!digits) { setResultadosAmarrado([]); setAmarradosSelecionadosBusca([]); return }
    try {
      const achados = []
      for (const l of (lotesDB || [])) {
        const loteStr = String(l.lote || '').replace(/\D/g, '')
        const codigoStr = String(l.codigo || '').replace(/\D/g, '')
        const origAmarr = String(getCampoOriginalLote(l, 'Amarrado') || '').replace(/\D/g, '')
        const match = (loteStr && loteStr.includes(digits)) || (codigoStr && codigoStr.includes(digits)) || (origAmarr && origAmarr.includes(digits))
        if (match) {
          achados.push({
            rack: String(l.rack_embalagem || '').trim(),
            lote: String(l.lote || '').trim(),
            produto: String(l.produto || getCampoOriginalLote(l, 'Produto') || '').trim(),
            pedido_seq: String(l.pedido_seq || '').trim(),
            romaneio: String(l.romaneio || '').trim(),
            codigo: String(l.codigo || '').trim(),
            qt_kg: Number(l.qt_kg || 0),
            qtd_pc: Number(l.qtd_pc || 0)
          })
        }
      }
      setResultadosAmarrado(achados)
      setAmarradosSelecionadosBusca([])
    } catch { 
      setResultadosAmarrado([])
      setAmarradosSelecionadosBusca([])
    }
  }

  // Salva apenas os amarrados selecionados como lotes externos
  const salvarAmarradosSelecionados = () => {
    const selecionados = amarradosSelecionadosBusca.map(idx => resultadosAmarrado[idx])
    if (!selecionados.length) {
      alert('Selecione pelo menos um amarrado.')
      return
    }
    
    // Extrai os números dos lotes dos amarrados selecionados
    const novosLotes = selecionados.map(a => a.lote).filter(Boolean)
    
    // Coleta todos os racks únicos dos amarrados selecionados
    const racksUnicos = Array.from(new Set(selecionados.map(a => a.rack).filter(Boolean)))
    
    // Adiciona os novos lotes aos já existentes (sem duplicar)
    const lotesExistentes = lotesSelecionados || []
    const lotesUnicos = Array.from(new Set([...lotesExistentes, ...novosLotes]))
    
    // Atualiza os lotes selecionados no modal principal
    setLotesSelecionados(lotesUnicos)
    
    // Não preenche o campo Rack!Embalagem quando usar "Procurar por Amarrado"
    // Deixa vazio para evitar conflitos, já que os amarrados podem vir de racks diferentes
    
    // Cria objetos de lote para exibição na lista "Lotes encontrados"
    const novosLotesObj = selecionados.map(a => ({
      lote: a.lote,
      produto: a.produto,
      ferramenta: extrairFerramenta(a.produto || ''),
      comprimentoLongoMm: extrairComprimentoLongoMm(a.produto || ''),
      romaneio: a.romaneio,
      pedido: a.pedido_seq ? a.pedido_seq.split('/')[0] : '',
      seq: a.pedido_seq ? a.pedido_seq.split('/')[1] : '',
      rack: a.rack // Adiciona informação do rack para cada lote
    }))
    
    // Adiciona aos lotes encontrados (sem duplicar)
    setLotesEncontrados(prev => {
      const existentes = prev.filter(l => !novosLotes.includes(l.lote))
      return [...existentes, ...novosLotesObj]
    })
    
    // Adiciona aos amarrados acumulados para mostrar na lateral
    setAmarradosAcumulados(prev => {
      const existentes = prev.filter(a => !novosLotes.includes(a.lote))
      return [...existentes, ...selecionados]
    })
    
    // Limpa a seleção atual da busca
    setAmarradosSelecionadosBusca([])
    setResultadosAmarrado([])
    setNumeroAmarrado('')
    
    alert(`${selecionados.length} amarrado(s) adicionado(s) à seleção. Total: ${lotesUnicos.length} lote(s) selecionado(s).`)
  }

  // Marca/desmarca um número de lote
  const toggleLoteSelecionado = (num) => {
    setLotesSelecionados(prev => prev.includes(num) ? prev.filter(x => x !== num) : [...prev, num])
  }

  // Marca/desmarca um amarrado específico
  const toggleAmarradoSelecionado = (amarrado) => {
    setAmarradosSelecionadosRack(prev => {
      const existe = prev.some(a => a.codigo === amarrado.codigo && a.lote === amarrado.lote)
      if (existe) {
        return prev.filter(a => !(a.codigo === amarrado.codigo && a.lote === amarrado.lote))
      } else {
        return [...prev, amarrado]
      }
    })
  }

  // Seleciona todos os amarrados de um lote
  const selecionarTodosAmarradosDoLote = (lote) => {
    const loteObj = lotesEncontrados.find(l => l.lote === lote)
    if (!loteObj || !loteObj.amarrados) return
    
    setAmarradosSelecionadosRack(prev => {
      // Remove amarrados existentes deste lote
      const semEsteL = prev.filter(a => a.lote !== lote)
      // Adiciona todos os amarrados do lote
      return [...semEsteL, ...loteObj.amarrados]
    })
  }

  // Desmarca todos os amarrados de um lote
  const desmarcarTodosAmarradosDoLote = (lote) => {
    setAmarradosSelecionadosRack(prev => prev.filter(a => a.lote !== lote))
  }

  // Verifica se todos os amarrados de um lote estão selecionados
  const todoAmarradosDoLoteSelecionados = (lote) => {
    const loteObj = lotesEncontrados.find(l => l.lote === lote)
    if (!loteObj || !loteObj.amarrados || loteObj.amarrados.length === 0) return false
    return loteObj.amarrados.every(a => 
      amarradosSelecionadosRack.some(sel => sel.codigo === a.codigo && sel.lote === a.lote)
    )
  }

  // Toggle expandir/recolher lote
  const toggleLoteExpandido = (lote) => {
    setLotesExpandidos(prev => 
      prev.includes(lote) ? prev.filter(l => l !== lote) : [...prev, lote]
    )
  }

  // Salva Rack e lotes escolhidos no formulário principal
  const salvarRackELotes = () => {
    const rack = String(rackDigitado || '').trim()
    
    // Prioriza amarrados selecionados individualmente
    if (amarradosSelecionadosRack.length > 0) {
      const lotesUnicos = Array.from(new Set(amarradosSelecionadosRack.map(a => a.lote)))
      const racksUnicos = Array.from(new Set(amarradosSelecionadosRack.map(a => a.rack).filter(Boolean)))
      const rackFinal = racksUnicos.length > 1 ? 'MÚLTIPLOS RACKS' : (racksUnicos[0] || rack)
      
      setFormData(prev => ({
        ...prev,
        rack_ou_pallet: rackFinal,
        rackOuPallet: rackFinal,
        lotesExternos: lotesUnicos,
        amarradosDetalhados: amarradosSelecionadosRack
      }))
      setRackModalAberto(false)
      setAmarradosSelecionadosRack([])
      setLotesExpandidos([])
      return
    }
    
    // Verifica se há lotes selecionados
    if (!lotesSelecionados.length) { 
      if (!window.confirm('Nenhum lote selecionado. Deseja continuar assim mesmo?')) return 
    }
    
    // Se não há rack definido mas há lotes selecionados (vindos da busca por amarrado)
    if (!rack && lotesSelecionados.length > 0) {
      // Verifica se os lotes têm informação de rack individual
      const lotesComRack = lotesEncontrados.filter(l => lotesSelecionados.includes(l.lote) && l.rack)
      
      if (lotesComRack.length > 0) {
        // Usa "MÚLTIPLOS RACKS" se há lotes de racks diferentes, senão usa o rack único
        const racksUnicos = Array.from(new Set(lotesComRack.map(l => l.rack)))
        const rackFinal = racksUnicos.length > 1 ? 'MÚLTIPLOS RACKS' : racksUnicos[0]
        
        setFormData(prev => ({
          ...prev,
          rack_ou_pallet: rackFinal,
          rackOuPallet: rackFinal,
          lotesExternos: [...lotesSelecionados]
        }))
        setRackModalAberto(false)
        setAmarradosSelecionadosRack([])
        return
      }
    }
    
    // Fluxo normal: exige rack quando não há lotes ou quando rack foi digitado
    if (!rack) { 
      alert('Informe o Rack!Embalagem ou use "Procurar por Amarrado" para selecionar lotes.'); 
      return 
    }
    
    setFormData(prev => ({
      ...prev,
      rack_ou_pallet: rack,
      rackOuPallet: rack,
      lotesExternos: [...lotesSelecionados]
    }))
    setRackModalAberto(false)
    setAmarradosSelecionadosRack([])
  }
  
  // Lista simulada de operadores (máquinas virão do IndexedDB)
  const operadores = [
    { id: 1, nome: 'João Silva' },
    { id: 2, nome: 'Maria Oliveira' },
    { id: 3, nome: 'Carlos Santos' }
  ]
  // Máquinas reais cadastradas em Configurações (IndexedDB)
  const { items: maquinas } = useSupabase('maquinas')
  
  // Extrai o comprimento do perfil longo (material longo)
  const extrairComprimentoPerfilLongo = (perfilLongo) => {
    if (!perfilLongo) return ''
    const resto = String(perfilLongo).slice(8)
    const match = resto.match(/^\d+/)
    const valor = match ? parseInt(match[0], 10) : null
    return Number.isFinite(valor) ? `${valor} mm` : ''
  }

  // Converte um valor datetime-local (YYYY-MM-DDTHH:MM) para Date local
  const parseLocalInputToDate = (val) => {
    try {
      const [datePart, timePart] = String(val || '').split('T')
      if (!datePart || !timePart) return null
      const [yy, mm, dd] = datePart.split('-').map(Number)
      const [hh, mi] = timePart.split(':').map(Number)
      return new Date(yy, (mm || 1) - 1, dd || 1, hh || 0, mi || 0)
    } catch { return null }
  }

  // Converte datetime-local (YYYY-MM-DDTHH:MM) para ISO (UTC) esperado pelo Supabase
  const localInputToISO = (val) => {
    const d = parseLocalInputToDate(val)
    return d && !isNaN(d.getTime()) ? d.toISOString() : null
  }

  // Formata duração em HH:MM:SS
  const formatHMS = (ms) => {
    const total = Math.max(0, Math.floor((ms || 0) / 1000))
    const hh = String(Math.floor(total / 3600)).padStart(2, '0')
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
    const ss = String(total % 60).padStart(2, '0')
    return `${hh}:${mm}:${ss}`
  }

  // Limpa o formulário e o rascunho salvo
  const clearForm = () => {
    try { if (typeof window !== 'undefined') localStorage.removeItem(STORAGE_KEY) } catch {}
    setFormData({
      operador: user ? user.nome : '',
      maquina: '',
      processoEmbalagem: 'somente_embalagem',
      etapaEmbalagem: 'EMBALAGEM',
      codigoPerfil: '',
      ordemTrabalho: '',
      inicio: '',
      fim: '',
      quantidade: '',
      qtdPedido: 0,
      perfilLongo: '',
      separado: '',
      cliente: '',
      pedidoCliente: '',
      dtFatura: '',
      unidade: '',
      comprimentoAcabado: '',
      nroOp: '',
      observacoes: '',
      romaneioNumero: '',
      loteExterno: '',
      lotesExternos: [],
      codigoProdutoCliente: ''
    })
  }

  // Obtém um campo de dados_originais com busca case-insensitive e ignorando pontuação
  const getCampoOriginal = (pedido, campo) => {
    try {
      const dados = pedido?.dados_originais || {}
      const alvo = String(campo).toLowerCase().replace(/[^a-z0-9]/g, '')
      for (const k of Object.keys(dados)) {
        const nk = String(k).toLowerCase().replace(/[^a-z0-9]/g, '')
        if (nk === alvo) return dados[k]
      }
      return ''
    } catch {
      return ''
    }
  }

  const normalizarPedidoCliente = (v) => {
    try {
      const s = String(v ?? '').trim()
      if (!s) return ''
      return s.replace(/\.0$/, '')
    } catch {
      return ''
    }
  }

  const obterPedidoClientePedido = (p) => {
    const v =
      p?.pedido_cliente
      || getCampoOriginal(p, 'PEDIDO.CLIENTE')
      || getCampoOriginal(p, 'PEDIDO DO CLIENTE')
      || getCampoOriginal(p, 'PEDIDO CLIENTE')
      || getCampoOriginal(p, 'NUMERO PEDIDO')
      || getCampoOriginal(p, 'NÚMERO PEDIDO')
      || getCampoOriginal(p, 'NRO PEDIDO')
      || getCampoOriginal(p, 'Nº PEDIDO')
      || ''
    return normalizarPedidoCliente(v)
  }

  // Formata data/hora atual no padrão aceito por inputs type="datetime-local"
  // Saída: YYYY-MM-DDTHH:MM (hora local)
  const getNowLocalInput = () => {
    const pad = (n) => String(n).padStart(2, '0')
    const d = new Date()
    const y = d.getFullYear()
    const m = pad(d.getMonth() + 1)
    const day = pad(d.getDate())
    const hh = pad(d.getHours())
    const mm = pad(d.getMinutes())
    return `${y}-${m}-${day}T${hh}:${mm}`
  }

  // Soma minutos a um valor no formato datetime-local e retorna no mesmo formato
  const addMinutesToInput = (inputValue, minutes) => {
    try {
      const pad = (n) => String(n).padStart(2, '0')
      const [datePart, timePart] = String(inputValue || getNowLocalInput()).split('T')
      const [yy, mm, dd] = datePart.split('-').map(Number)
      const [hh, mi] = (timePart || '00:00').split(':').map(Number)
      const d = new Date(yy, (mm || 1) - 1, dd || 1, hh || 0, mi || 0)
      d.setMinutes(d.getMinutes() + (Number.isFinite(minutes) ? minutes : 0))
      const Y = d.getFullYear()
      const M = pad(d.getMonth() + 1)
      const D = pad(d.getDate())
      const H = pad(d.getHours())
      const Min = pad(d.getMinutes())
      return `${Y}-${M}-${D}T${H}:${Min}`
    } catch {
      return inputValue
    }
  }

  // Ordens de trabalho derivadas da Carteira (pedidos importados)
  const ordensTrabalhoTodas = pedidosDB
    .filter(p => !p?.finalizado_manual)
    .map(p => {
    // Produto completo para cálculo de comprimento (similar aos painéis de EXP)
    const produtoCompleto = p.produto || getCampoOriginal(p, 'Produto') || getCampoOriginal(p, 'Ferramenta') || ''
    const comp = extrairComprimentoAcabado(produtoCompleto)
    const ferramenta = extrairFerramenta(p.produto)
    // Perfil longo e separado podem vir direto da tabela ou da planilha original
    const perfilLongo = p.item_perfil 
      || getCampoOriginal(p, 'ITEM.PERFIL') 
      || getCampoOriginal(p, 'ITEM PERFIL') 
      || getCampoOriginal(p, 'PERFIL LONGO') 
      || ''
    const separadoBruto = p.separado ?? getCampoOriginal(p, 'SEPARADO') ?? 0
    const separadoNum = Number(String(separadoBruto).replace(/\D/g, '')) || 0
    // Datas podem estar em DT.FATURA ou DATA ENTREGA na planilha
    const dtFatura = p.dt_fatura 
      || getCampoOriginal(p, 'DT.FATURA') 
      || getCampoOriginal(p, 'DATA ENTREGA') 
      || ''
    // Nº OP pode vir de várias colunas na planilha
    const nroOp = p.nro_op 
      || getCampoOriginal(p, 'NRO DA OP') 
      || getCampoOriginal(p, 'Nº OP') 
      || getCampoOriginal(p, 'OP') 
      || ''

    return {
      id: p.pedido_seq,                  // Ex.: "82594/10"
      codigoPerfil: p.produto || '',     // Código do produto (como exibido na carteira)
      descricao: p.descricao || '',      // Descrição do produto
      qtdPedido: Number(p.qtd_pedido || 0),      // Quantidade pedida
      perfilLongo,                       // Item/Perfil (fallback da planilha)
      separado: separadoNum,             // Quantidade separada
      cliente: getCampoOriginal(p, 'CLIENTE') || p.cliente || '',
      pedidoCliente: obterPedidoClientePedido(p),
      dtFatura,
      unidade: p.unidade || '',
      comprimentoAcabado: comp,
      ferramenta,
      nroOp
    }
  })
  
  // Se estiver no modo "embalagem", exibir apenas pedidos que JÁ POSSUEM apontamentos registrados
  const ordensComApontamentoSet = useMemo(() => {
    try {
      return new Set(
        (apontamentosDB || [])
          .map(a => String(a.ordemTrabalho || a.ordem_trabalho || a.pedido_seq || '').trim())
          .filter(Boolean)
      )
    } catch {
      return new Set()
    }
  }, [apontamentosDB])

  const ordensBase = useMemo(() => {
    if (modo === 'embalagem') {
      return ordensTrabalhoTodas.filter(o => ordensComApontamentoSet.has(String(o.id)))
    }
    return ordensTrabalhoTodas
  }, [modo, ordensTrabalhoTodas, ordensComApontamentoSet])

  // Aplicar filtro de prioridades se ativo
  const ordensTrabalho = filtrarPrioridades 
    ? ordensBase.filter(o => pedidosPrioritarios.has(o.id))
    : ordensBase

  // Caminhos base para PDFs salvos em Configurações
  const pdfBasePath = typeof window !== 'undefined' ? (localStorage.getItem('pdfBasePath') || '') : ''
  const processBasePath = typeof window !== 'undefined' ? (localStorage.getItem('processBasePath') || '') : ''
  const ferramentaAtual = extrairFerramenta(formData.codigoPerfil)
  const comprimentoAtual = String(formData.comprimentoAcabado || '').replace(/\D/g, '')
  const autoDocumentoAbertoRef = useRef('')
  const normalizarComprimentoComparacao = (valor) => {
    const digits = String(valor || '').replace(/\D/g, '')
    if (!digits) return ''
    return String(parseInt(digits, 10))
  }
  const BACKEND_URL = (import.meta?.env?.VITE_BACKEND_URL || 'http://localhost:8000').replace(/\/$/, '')
  const buildHttpPdfUrl = (basePath, fileName) => {
    // Usa o backend para servir o arquivo via HTTP
    const params = new URLSearchParams({ base: basePath || '' })
    const fname = fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`
    return `${BACKEND_URL}/api/files/pdf/${encodeURIComponent(fname)}?${params.toString()}`
  }

  const abrirPdfArquivo = async (basePath, fileName) => {
    const { base, file } = normalizePdfBaseAndFile(basePath, fileName)
    if (!base || !file) return

    const localUrl = buildLocalFileUrl(base, file)
    const localPath = `${String(base).replace(/[\\/]+$/,'')}\\${file}`
    const httpUrl = buildHttpPdfUrl(base, file)

    // 1) Tenta via backend HTTP primeiro (mais confiável no navegador)
    // Usa janela nomeada 'pdf_viewer' para sempre reutilizar a mesma janela
    // (arrastar para o segundo monitor uma vez e ela sempre volta lá)
    try {
      const w = window.open(httpUrl, 'pdf_viewer')
      if (w) { w.blur(); window.focus(); return }
    } catch {}

    // 2) Fallback: tenta abrir direto via file:/// (pode ser bloqueado)
    try {
      const wLocal = window.open(localUrl, 'pdf_viewer')
      if (wLocal) { wLocal.blur(); window.focus(); return }
    } catch {}

    // 3) Último recurso: copia o caminho para a área de transferência
    try { await navigator.clipboard.writeText(localPath) } catch {}
    alert('Não foi possível abrir automaticamente.\n\nCaminho copiado para a área de transferência:\n' + localPath + '\n\nDica: Certifique-se de que o backend está rodando em http://localhost:8000')
  }

  const cfgDocumentoAtual = useMemo(() => {
    const itens = Array.isArray(ferramentasCfg) ? ferramentasCfg : []
    if (!ferramentaAtual) return null
    const comprimentoNormalizado = normalizarComprimentoComparacao(comprimentoAtual)

    const exato = itens.find(cfg => (
      String(cfg?.ferramenta || '').toUpperCase() === String(ferramentaAtual || '').toUpperCase()
      && normalizarComprimentoComparacao(cfg?.comprimento_mm) === comprimentoNormalizado
    ))

    if (exato) return exato

    return itens.find(cfg => String(cfg?.ferramenta || '').toUpperCase() === String(ferramentaAtual || '').toUpperCase()) || null
  }, [ferramentasCfg, ferramentaAtual, comprimentoAtual])

  const documentoKeyAtual = useMemo(() => {
    if (!ferramentaAtual) return ''
    const compNorm = normalizarComprimentoComparacao(comprimentoAtual)
    if (!compNorm) return ''
    return `${ferramentaAtual}__${compNorm}`
  }, [ferramentaAtual, comprimentoAtual])

  const docsAtivosAtual = useMemo(() => {
    const itens = Array.isArray(documentosFerramentas) ? documentosFerramentas : []
    if (!documentoKeyAtual) return {}

    const ativos = itens.filter(doc => (
      String(doc?.ferramenta_id || '') === documentoKeyAtual && doc?.ativo === true
    ))

    const mapa = {}
    for (const doc of ativos) {
      mapa[doc.tipo_documento] = doc
    }
    return mapa
  }, [documentosFerramentas, documentoKeyAtual])

  const desenhoUrlAtual = cfgDocumentoAtual?.desenho_pdf_url || docsAtivosAtual?.desenho?.url_arquivo || ''
  const fichaUrlAtual = cfgDocumentoAtual?.ficha_processo_pdf_url || docsAtivosAtual?.ficha_processo?.url_arquivo || ''
  const fotoUrlAtual = cfgDocumentoAtual?.foto_padronizacao_url || docsAtivosAtual?.foto_padronizacao?.url_arquivo || ''

  const abrirDocumentoUrl = (url) => {
    if (!url) return
    const w = window.open(url, 'pdf_viewer')
    if (w) { w.blur(); window.focus() }
  }

  const abrirDesenhoManual = () => {
    if (desenhoUrlAtual) {
      abrirDocumentoUrl(desenhoUrlAtual)
      return
    }

    if (!ferramentaAtual) {
      alert('Não foi possível identificar a ferramenta a partir do Produto.')
      return
    }

    if (!pdfBasePath) {
      alert('Defina o caminho base dos PDFs em Configurações > Arquivos.')
      return
    }

    abrirPdfArquivo(pdfBasePath, `${ferramentaAtual}.pdf`)
  }

  const abrirFichaProcessoManual = () => {
    if (fichaUrlAtual) {
      abrirDocumentoUrl(fichaUrlAtual)
      return
    }

    if (!ferramentaAtual) {
      alert('Não foi possível identificar a ferramenta a partir do Produto.')
      return
    }

    if (!processBasePath) {
      alert('Defina o caminho das fichas em Configurações > Arquivos.')
      return
    }

    abrirPdfArquivo(processBasePath, `${ferramentaAtual}.pdf`)
  }

  const abrirFotoPadronizacaoManual = () => {
    if (fotoUrlAtual) {
      abrirDocumentoUrl(fotoUrlAtual)
      return
    }

    alert('Nenhuma foto de padronização cadastrada para esta matriz/comprimento.')
  }

  // Função simplificada de upload direto do cabeçalho
  const handleUploadFotoCabecalho = async (file) => {
    if (!file) return
    if (!isAdmin() && !user?.nivel_acesso?.toLowerCase().includes('super')) {
      alert('Apenas administradores ou supervisores podem alterar a foto.')
      return
    }

    try {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        throw new Error('Formato inválido. Use JPG, PNG ou WEBP.')
      }
      if (file.size > 10 * 1024 * 1024) {
        throw new Error('A imagem deve ter no máximo 10MB.')
      }

      const nomeArquivo = `${documentoKeyAtual}_foto_padronizacao_${Date.now()}_${file.name}`
      const caminho = `documentos-ferramentas/${documentoKeyAtual}/foto_padronizacao/${nomeArquivo}`

      const { error: erroUpload } = await supabaseService.supabase.storage
        .from('documentos')
        .upload(caminho, file, { upsert: true })

      if (erroUpload) throw erroUpload

      const { data: publicData } = supabaseService.supabase.storage
        .from('documentos')
        .getPublicUrl(caminho)

      const publicUrl = publicData?.publicUrl || ''

      const docsAntigos = await supabaseService.getWhere('documentos_ferramentas', [
        { column: 'ferramenta_id', operator: 'eq', value: documentoKeyAtual },
        { column: 'tipo_documento', operator: 'eq', value: 'foto_padronizacao' },
        { column: 'ativo', operator: 'eq', value: true }
      ])

      for (const doc of docsAntigos || []) {
        await supabaseService.update('documentos_ferramentas', doc.id, { ativo: false })
      }

      const novoDoc = {
        ferramenta_id: documentoKeyAtual,
        tipo_documento: 'foto_padronizacao',
        nome_arquivo: file.name,
        url_arquivo: publicUrl,
        tamanho_bytes: file.size,
        mime_type: file.type,
        versao: ((docsAntigos && docsAntigos[0]?.versao) || 0) + 1,
        ativo: true,
        uploaded_by: user?.nome || 'sistema',
        descricao: `Upload de foto_padronizacao`
      }

      await supabaseService.add('documentos_ferramentas', novoDoc)

      if (cfgDocumentoAtual?.id) {
        await supabaseService.update('ferramentas_cfg', cfgDocumentoAtual.id, {
          foto_padronizacao_url: publicUrl,
          updated_at: new Date().toISOString()
        })
      }

      alert('Foto enviada com sucesso! A página será atualizada para mostrar a nova imagem.')
      window.location.reload()
    } catch (err) {
      console.error('Erro no upload:', err)
      alert(`Erro ao enviar foto: ${err.message || 'Falha desconhecida'}`)
    }
  }

  const handleTogglePerguntarFotoMontagem = (checked) => {
    setPerguntarFotoMontagem(checked)
    try {
      if (typeof window !== 'undefined') {
        localStorage.setItem(FOTO_MONTAGEM_PREF_KEY, String(checked))
      }
    } catch {}
  }

  const abrirDesenho = () => {
    if (!ferramentaAtual) {
      alert('Não foi possível identificar a ferramenta a partir do Produto.')
      return
    }
    if (!pdfBasePath) {
      alert('Defina o caminho base dos PDFs em Configurações > Arquivos.')
      return
    }
    const arquivo = `${ferramentaAtual}.pdf`
    const url = buildFileUrl(pdfBasePath, arquivo)
    // Tenta abrir via window.open
    const w = window.open(encodeURI(url), '_blank')
    // Fallback silencioso via <a>
    if (!w) {
      const a = document.createElement('a')
      a.href = encodeURI(url)
      a.target = '_blank'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => {
        alert(`Tentei abrir o arquivo:\n${url}\n\nSe o navegador bloqueou a abertura de arquivos locais (file:///), habilite a permissão ou solicite que disponibilizemos via servidor.`)
      }, 150)
    }
  }

  useEffect(() => {
    const chaveAtual = `${formData.ordemTrabalho || ''}__${ferramentaAtual || ''}__${comprimentoAtual || ''}`

    if (!formData.ordemTrabalho || !ferramentaAtual || !cfgDocumentoAtual) {
      autoDocumentoAbertoRef.current = ''
      return
    }

    if (autoDocumentoAbertoRef.current === chaveAtual) return

    const urlAuto = desenhoUrlAtual || fichaUrlAtual || ''
    if (!urlAuto) return

    // Usar setTimeout para evitar erro de concorrência do React
    setTimeout(() => {
      if (autoDocumentoAbertoRef.current === chaveAtual) {
        abrirDocumentoUrl(urlAuto)
      }
    }, 100)
    
    autoDocumentoAbertoRef.current = chaveAtual
  }, [formData.ordemTrabalho, ferramentaAtual, comprimentoAtual, cfgDocumentoAtual, desenhoUrlAtual, fichaUrlAtual])

  // Atualização do Preview da etiqueta
  useEffect(() => {
    let ativo = true

    const atualizarPreview = () => {
      if (!etiquetaPreviewAberta || tipoPreview !== 'etiqueta_palete' || !apontamentoPreview) {
        return
      }

      // O QR Code foi removido e substituído por código de barras no componente interno
      // Não é mais necessário gerar QR Code base64 aqui
    }

    atualizarPreview()

    return () => {
      ativo = false
    }
  }, [etiquetaPreviewAberta, apontamentoPreview, tipoPreview, maquinas, tipoPaleteManual, statusPaleteManual, fifoPaleteManual])

  // Gerar ou reutilizar rack quando o modal de confirmação é aberto
  useEffect(() => {
    if (!confirmarAberto) return

    const gerarOuReutilizarRack = async () => {
      try {
        // Primeiro, verificar se existe um rack em aberto para o mesmo produto/ordem
        const rackEmAberto = await supabaseService.buscarRackEmAberto(
          formData.produto,
          formData.ordemTrabalho
        )

        setEditandoRack(false)
        if (rackEmAberto) {
          // Reutilizar rack existente — checkbox padrão = false (rack ainda não finalizado)
          console.log('Rack em aberto encontrado:', rackEmAberto)
          setFormData(prev => ({ ...prev, rack_acabado: rackEmAberto }))
          setFinalizarRack(false)
        } else {
          // Novo rack — checkbox padrão = true (finalizar ao confirmar)
          const proximoRack = await supabaseService.obterProximoRackUsinagem()
          if (proximoRack) {
            console.log('Novo rack gerado:', proximoRack)
            setFormData(prev => ({ ...prev, rack_acabado: proximoRack }))
          }
          setFinalizarRack(true)
        }
      } catch (err) {
        console.error('Erro ao gerar/reutilizar rack:', err)
        setFinalizarRack(true)
        setEditandoRack(false)
      }
    }

    gerarOuReutilizarRack()
  }, [confirmarAberto, formData.produto, formData.ordemTrabalho])

  // Pedido genérico fixo para testes e trabalhos sem pedido formal
  const PEDIDO_GENERICO = {
    id: 'TESTE/01',
    codigoPerfil: '',
    descricao: 'Testes / Cortes sem Pedido',
    qtdPedido: 0,
    perfilLongo: '',
    separado: 0,
    cliente: 'USO INTERNO',
    pedidoCliente: '-',
    dtFatura: '',
    unidade: 'PC',
    comprimentoAcabado: '',
    ferramenta: '',
    nroOp: '',
    _generico: true
  }

  // Mapa pedido_seq → total apontado, para calcular saldo correto em cada linha do modal de busca
  const totalApontadoPorPedido = useMemo(() => {
    const mapa = {}
    for (const a of (apontamentosDB || [])) {
      const seq = String(a.ordem_trabalho || a.ordemTrabalho || a.pedido_seq || '').trim()
      if (!seq) continue
      const qtd = Number(a.quantidade || a.quantidadeProduzida || 0)
      mapa[seq] = (mapa[seq] || 0) + (isNaN(qtd) ? 0 : qtd)
    }
    return mapa
  }, [apontamentosDB])

  // Lista filtrada para modal de busca, ordenada por Data Entrega (mais antigas no topo)
  const ordensFiltradas = useMemo(() => {
    const filtradas = ordensTrabalho.filter(o => {
      if (!buscaTexto) return true
      const t = buscaTexto.toString().trim().toLowerCase()
      const tDigits = t.replace(/\D/g, '')
      const comprimentoNum = (o.comprimentoAcabado || '').replace(/\D/g, '')
      const comprimentoLongoNum = extrairComprimentoPerfilLongo(o.perfilLongo || '').replace(/\D/g, '')
      const idStr = String(o.id || '').toLowerCase()
      const idDigits = idStr.replace(/\D/g, '')
      const pedCliStr = String(o.pedidoCliente || '').toLowerCase()
      const pedCliDigits = pedCliStr.replace(/\D/g, '')

      // 1) Busca numérica: tenta comprimento (prefixo), comprimento longo e Pedido/Seq por dígitos
      if (tDigits) {
        if (comprimentoNum.startsWith(tDigits)) return true
        if (comprimentoLongoNum.startsWith(tDigits)) return true
        if (idDigits.includes(tDigits)) return true
        if (pedCliDigits && pedCliDigits.includes(tDigits)) return true
      }

      // 2) Busca textual (case-insensitive)
      if (idStr.includes(t)) return true
      if ((o.ferramenta || '').toLowerCase().includes(t)) return true
      if ((o.codigoPerfil || '').toLowerCase().includes(t)) return true
      if (pedCliStr.includes(t)) return true
      if ((o.cliente || '').toLowerCase().includes(t)) return true

      return false
    })
    
    // Ordenar por Data Entrega (mais antigas no topo)
    filtradas.sort((a, b) => {
      const dataA = a.dtFatura ? new Date(a.dtFatura).getTime() : Infinity
      const dataB = b.dtFatura ? new Date(b.dtFatura).getTime() : Infinity
      return dataA - dataB
    })

    // Pedido genérico sempre no topo (aparece se busca vazia ou texto bate)
    const t = (buscaTexto || '').trim().toLowerCase()
    const incluirGenerico = !t || 'teste'.includes(t) || 'interno'.includes(t) || 'generico'.includes(t) || 'sem pedido'.includes(t) || 'teste/01'.includes(t)
    return incluirGenerico ? [PEDIDO_GENERICO, ...filtradas] : filtradas
  }, [ordensTrabalho, buscaTexto])
  
  // Atualizar o operador quando o usuário for carregado
  useEffect(() => {
    if (user) {
      setFormData(prevData => ({
        ...prevData,
        operador: user.nome
      }))
    }
  }, [user])

  // Buscar código do cliente automaticamente quando código do perfil mudar
  useEffect(() => {
    if (formData.codigoPerfil && formData.codigoPerfil.trim()) {
      buscarCodigoClienteAutomatico(formData.codigoPerfil)
    }
  }, [formData.codigoPerfil])

  // Buscar código do cliente automaticamente
  const buscarCodigoClienteAutomatico = async (codigoTecno) => {
    try {
      const codigoPreferencial = await BuscaCodigoClienteService.buscarCodigoPreferencial(codigoTecno)
      if (codigoPreferencial) {
        setFormData(prev => ({
          ...prev,
          codigoProdutoCliente: codigoPreferencial.codigo_cliente
        }))
        console.log(`Código do cliente encontrado automaticamente: ${codigoPreferencial.codigo_cliente} para ${codigoTecno}`)
      }
    } catch (error) {
      console.error('Erro ao buscar código do cliente automático:', error)
    }
  }

  // Carrega rascunho salvo ao montar ou quando modo muda
  useEffect(() => {
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
      if (raw) {
        const saved = JSON.parse(raw)
        if (saved && typeof saved === 'object') {
          setFormData(prev => ({
            ...prev,
            ...saved,
            // garante operador do usuário atual quando disponível
            operador: (user && user.nome) ? user.nome : (saved.operador || prev.operador)
          }))
        }
      }
    } catch {}
    setDraftLoaded(true)
  }, [modo, user])

  // Salva rascunho automaticamente sempre que o form mudar (após carregar)
  useEffect(() => {
    if (!draftLoaded) return
    try {
      if (typeof window !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(formData))
      }
    } catch {}
  }, [formData, draftLoaded, STORAGE_KEY])

  const handleChange = (e) => {
    const { name, value } = e.target
    
    // Se selecionou uma ordem de trabalho, preenche os campos relacionados automaticamente
    if (name === 'ordemTrabalho') {
      // Tratamento especial para o pedido genérico TESTE/01
      if (value === 'TESTE/01') {
        const inicioAuto = formData.inicio || getNowLocalInput()
        setFormData({
          ...formData,
          ordemTrabalho: 'TESTE/01',
          codigoPerfil: '',           // usuário deve preencher manualmente
          qtdPedido: 0,
          perfilLongo: '',
          separado: 0,
          cliente: 'USO INTERNO',
          pedidoCliente: '-',
          dtFatura: '',
          unidade: 'PC',
          comprimentoAcabado: '',
          nroOp: '',
          rackOuPallet: '',
          rack_ou_pallet: '',
          lotesExternos: [],
          amarradosDetalhados: [],
          inicio: inicioAuto,
          fim: formData.fim || addMinutesToInput(inicioAuto, 60)
        })
        // Para TESTE/01 não há rack obrigatório — não abre modal de rack
        setPedidoSeqSelecionado('TESTE/01')
        setRackDigitado('')
        setLotesEncontrados([])
        setLotesSelecionados([])
        return
      }

      const ordem = ordensTrabalho.find(o => o.id === value)
      if (ordem) {
        const inicioAuto = formData.inicio || getNowLocalInput()
        setFormData({
          ...formData,
          ordemTrabalho: value,
          codigoPerfil: ordem.codigoPerfil,
          qtdPedido: ordem.qtdPedido,
          perfilLongo: ordem.perfilLongo,
          separado: ordem.separado,
          cliente: ordem.cliente,
          pedidoCliente: ordem.pedidoCliente,
          dtFatura: ordem.dtFatura,
          unidade: ordem.unidade,
          comprimentoAcabado: ordem.comprimentoAcabado,
          nroOp: ordem.nroOp,
          // Preenche início automaticamente se ainda não houver valor
          inicio: inicioAuto,
          // Define fim como 1 hora após o início, caso ainda esteja vazio
          fim: formData.fim || addMinutesToInput(inicioAuto, 60)
        })
        // Abre novo modal: Rack!Embalagem e lotes relacionados
        setPedidoSeqSelecionado(value)
        setRackDigitado('')
        setLotesEncontrados([])
        setLotesSelecionados([])
        setRackModalAberto(true)
        return
      }
    }
    
    setFormData({
      ...formData,
      [name]: value
    })
  }
  
  const handleSubmit = (e) => {
    e.preventDefault()
    // Validação extra para pedido genérico
    if (formData.ordemTrabalho === 'TESTE/01') {
      if (!String(formData.codigoPerfil || '').trim()) {
        alert('Para apontamentos de Teste/Sem Pedido, preencha o campo Produto com o perfil ou material utilizado.')
        return
      }
      const obs = String(formData.observacoes || '').trim()
      if (!obs) {
        alert('Para apontamentos de Teste/Sem Pedido, preencha as Observações descrevendo o trabalho e o comprimento cortado.\nExemplo: "Teste TR-0011 – corte 1265mm"')
        return
      }
    }
    // Abrir modal de confirmação antes de registrar
    setQtdConfirmada(String(formData.quantidade || ''))
    setRackOuPallet('')
    setQtdRefugo('')
    setComprimentoRefugo('')
    setDurezaMaterial('')
    setConfirmarAberto(true)
  }

  const concluirRegistro = async () => {
    const qtdForm = Number(formData.quantidade || 0)
    const qtdConf = Number(qtdConfirmada || 0)
    if (modo === 'embalagem' && formData.processoEmbalagem === 'rebarbar_embalar' && !String(formData.etapaEmbalagem || '').trim()) {
      alert('Selecione a Etapa (Rebarbar/Limpeza ou Embalagem).')
      return
    }
    if (qtdForm <= 0) {
      alert('Quantidade Produzida deve ser maior que zero.')
      return
    }
    if (qtdForm !== qtdConf) {
      alert('A quantidade confirmada deve ser igual à Quantidade Produzida.')
      return
    }
    // Mapeia para as colunas existentes na tabela public.apontamentos
    const lote = gerarCodigoLote()
    
    // Prepara detalhes completos dos amarrados para rastreabilidade
    const amarradosDetalhados = []
    if (formData.lotesExternos && formData.lotesExternos.length > 0) {
      // Busca detalhes completos de cada lote selecionado na base de dados
      for (const loteNum of formData.lotesExternos) {
        const loteDetalhado = (lotesDB || []).find(l => String(l.lote || '').trim() === loteNum)
        if (loteDetalhado) {
          amarradosDetalhados.push({
            codigo: String(loteDetalhado.codigo || '').trim(),
            rack: String(loteDetalhado.rack_embalagem || '').trim(),
            lote: String(loteDetalhado.lote || '').trim(),
            produto: String(loteDetalhado.produto || getCampoOriginalLote(loteDetalhado, 'Produto') || '').trim(),
            pedido_seq: String(loteDetalhado.pedido_seq || '').trim(),
            romaneio: String(loteDetalhado.romaneio || '').trim(),
            qt_kg: Number(loteDetalhado.qt_kg || 0),
            qtd_pc: Number(loteDetalhado.qtd_pc || 0),
            situacao: String(loteDetalhado.situacao || '').trim(),
            embalagem_data: loteDetalhado.embalagem_data || null,
            nota_fiscal: String(loteDetalhado.nota_fiscal || '').trim()
          })
        }
      }
    }

    // Campos extras para manter rastreabilidade por unidade/estágio sem criar novas tabelas
    const expFields = (modo === 'embalagem')
      ? {
          exp_unidade: 'embalagem',
          exp_stage: 'para-embarque',
          etapa_embalagem: (formData.processoEmbalagem === 'somente_embalagem')
            ? 'EMBALAGEM'
            : (String(formData.etapaEmbalagem || '').trim() || 'EMBALAGEM')
        }
      : {}

    const payloadDB = {
      operador: formData.operador || (user ? user.nome : ''),
      maquina: formData.maquina || '',
      produto: formData.codigoPerfil || '',
      cliente: formData.cliente || '',
      pedido_cliente: formData.pedidoCliente || '',
      inicio: localInputToISO(formData.inicio),
      fim: formData.fim ? localInputToISO(formData.fim) : null,
      quantidade: qtdForm,
      qtd_refugo: Number(qtdRefugo || 0),
      comprimento_refugo: Number(comprimentoRefugo || 0),
      qtd_pedido: formData.qtdPedido ? Number(formData.qtdPedido) : null,
      nro_op: formData.nroOp || '',
      perfil_longo: formData.perfilLongo || '',
      comprimento_acabado_mm: Number(String(formData.comprimentoAcabado || '').replace(/\D/g, '')) || null,
      ordem_trabalho: formData.ordemTrabalho || '',
      observacoes: formData.observacoes || '',
      rack_ou_pallet: rackOuPallet || '',
      rack_acabado: formData.rack_acabado || '',
      dureza_material: durezaMaterial || '',
      rack_finalizado: finalizarRack || false,
      // Guardar seleção de lotes internos/externos na coluna padronizada
      lotes_externos: (formData.lotesExternos && formData.lotesExternos.length ? [...formData.lotesExternos] : []),
      lote: lote,
      romaneio_numero: (formData.romaneioNumero && !/^0+$/.test(String(formData.romaneioNumero).trim())) ? String(formData.romaneioNumero).trim() : null,
      lote_externo: formData.loteExterno || '',
      // NOVO: Código do produto do cliente
      codigo_produto_cliente: formData.codigoProdutoCliente || '',
      // NOVO: Detalhes completos dos amarrados para rastreabilidade
      amarrados_detalhados: amarradosDetalhados.length > 0 ? amarradosDetalhados : null,
      ...expFields
    }
    try {
      const idCriado = await addApont(payloadDB)
      setUltimoApontamentoId(idCriado || '')
      console.log('Apontamento confirmado (Supabase):', payloadDB)
      
      // Força atualização dos apontamentos para garantir que o cálculo seja atualizado
      setTimeout(() => {
        recarregarApontamentos()
      }, 500)
      
    } catch (err) {
      console.error('Falha ao registrar apontamento no Supabase:', err)
      alert('Não foi possível registrar o apontamento no Supabase. Verifique a conexão e o schema.\nDetalhes: ' + (err?.message || 'erro desconhecido'))
      return
    }
    // Fecha modal de confirmação e abre o pop-up customizado
    setConfirmarAberto(false)
    setUltimoLote(lote)
    // Primeiro pergunta sobre impressão
    setImprimirAberto(true)
  }

  // Handlers do pop-up customizado
  const handleContinuarMesmoItem = () => {
    setContinuarMesmoItemAberto(false)
    setFormData(prev => ({ ...prev, quantidade: '' }))
    try {
      if (typeof window !== 'undefined') {
        const draft = { ...formData, quantidade: '' }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(draft))
      }
    } catch {}
  }

  const handleNovoItem = () => {
    setContinuarMesmoItemAberto(false)
    try { if (typeof window !== 'undefined') localStorage.removeItem(STORAGE_KEY) } catch {}
    clearForm()
  }

  // Helpers de distribuição de etiquetas
  const addLinhaDistribuicao = () => {
    setEtiquetasDistribuicao(prev => [...prev, { qtdPorEtiqueta: '', qtdEtiquetas: '' }])
  }

  const removeLinhaDistribuicao = (idx) => {
    setEtiquetasDistribuicao(prev => prev.filter((_, i) => i !== idx))
  }

  const atualizarDistribuicao = (idx, campo, valor) => {
    setEtiquetasDistribuicao(prev => prev.map((item, i) => i === idx ? { ...item, [campo]: valor } : item))
  }

  const lotesMPDisponiveis = useMemo(() => {
    const set = new Set()
    if (amarradosSelecionadosRack?.length) {
      amarradosSelecionadosRack.forEach(a => { if (a.lote) set.add(a.lote) })
    } else if (formData.lotesExternos?.length) {
      formData.lotesExternos.forEach(l => { if (l) set.add(l) })
    } else if (formData.loteExterno) {
      set.add(formData.loteExterno)
    }
    return Array.from(set)
  }, [amarradosSelecionadosRack, formData.lotesExternos, formData.loteExterno])

  useEffect(() => {
    if (!imprimirAberto) return
    if (!loteMPSelecionado && lotesMPDisponiveis.length > 0) {
      setLoteMPSelecionado(lotesMPDisponiveis[0])
    }
  }, [imprimirAberto, lotesMPDisponiveis, loteMPSelecionado])

  const preencherAmostraDoAmarrado = () => {
    const primeiro = amarradosSelecionadosRack && amarradosSelecionadosRack[0]
    if (!primeiro) return
    const qtd = Number(primeiro.qtd_pc || 0)
    setEtiquetasDistribuicao([{ qtdPorEtiqueta: qtd ? String(qtd) : '', qtdEtiquetas: '1' }])
    if (primeiro.lote) setLoteMPSelecionado(primeiro.lote)
  }

  // Ações do modal de imprimir
  const handleImprimirAgora = async () => {
    const parseNum = (v) => {
      if (v === undefined || v === null || v === '') return 0
      const n = Number(String(v).replace(',', '.'))
      return Number.isFinite(n) ? n : 0
    }

    // Monta distribuição informada; se vazia, usa 1 etiqueta com total
    let dist = etiquetasDistribuicao
      .map((item) => ({
        qtdPorEtiqueta: parseNum(item.qtdPorEtiqueta),
        qtdEtiquetas: parseNum(item.qtdEtiquetas)
      }))
      .filter((d) => d.qtdPorEtiqueta > 0 && d.qtdEtiquetas > 0)

    const qtdTotal = parseNum(formData.quantidade)
    if (!qtdTotal || qtdTotal <= 0) {
      alert('Informe a quantidade produzida para calcular as etiquetas.')
      return
    }

    if (dist.length === 0) {
      dist = [{ qtdPorEtiqueta: qtdTotal, qtdEtiquetas: 1 }]
    }

    const soma = dist.reduce((acc, d) => acc + d.qtdPorEtiqueta * d.qtdEtiquetas, 0)
    const totalEtiquetas = dist.reduce((acc, d) => acc + d.qtdEtiquetas, 0)
    if (soma !== qtdTotal) {
      alert(`A soma das etiquetas (${soma}) não bate com a quantidade produzida (${qtdTotal}). Ajuste a distribuição.`)
      return
    }

    const loteMP = String(
      loteMPSelecionado ||
        (lotesMPDisponiveis && lotesMPDisponiveis.length > 0 ? lotesMPDisponiveis[0] : '') ||
        (formData.lotesExternos && formData.lotesExternos[0]) ||
        formData.loteExterno ||
        ''
    ).trim()

    setImprimirAberto(false)
    if (tipoImpressao === 'etiqueta') {
      try {
        const totalEtiquetas = dist.reduce((acc, d) => acc + d.qtdEtiquetas, 0)
        const codBase = `${Date.now()}-${Math.floor(Math.random() * 1000)}`

        const apontamentoParaEtiqueta = {
          id: ultimoApontamentoId || null,
          lote: ultimoLote,
          lote_externo: loteMP,
          rack_ou_pallet: rackOuPallet,
          produto: formData.codigoPerfil || '',
          cliente: formData.cliente || '',
          dureza_material: durezaMaterial || 'N/A',
          ordemTrabalho: formData.ordemTrabalho || '',
          pedido_seq: formData.ordemTrabalho || ''
        }

        const distribuicaoComCodigos = dist.map((d, idx) => ({
          ...d,
          codigoEtiqueta: `${codBase}-${idx + 1}`,
          codigoProdutoCliente: formData.codigoProdutoCliente || ''
        }))

        const etiquetasRegistradas = await EtiquetasService.registrarEtiquetas(
          apontamentoParaEtiqueta,
          distribuicaoComCodigos,
          user?.nome || 'Sistema'
        )

        const idsRegistrados = (etiquetasRegistradas || []).map(e => e?.id).filter(Boolean)
        if (idsRegistrados.length > 0) {
          try { await EtiquetasService.marcarComoImpressa(idsRegistrados) } catch {}
        }
      } catch {}

      await imprimirEtiquetasTermicasEmLote({
        lote: ultimoLote,
        dist,
        rackOuPalletValor: rackOuPallet,
        dureza: durezaMaterial,
        loteMP
      })
    } else {
      imprimirDocumentoIdentificacao(ultimoLote, formData.quantidade, rackOuPallet, durezaMaterial, loteMP)
    }
    // Depois que escolher imprimir ou não, segue para a decisão de continuar no mesmo item
    setContinuarMesmoItemAberto(true)
  }
  const handleNaoImprimir = () => {
    setImprimirAberto(false)
    setContinuarMesmoItemAberto(true)
  }

  // ===== Romaneio/Lote Externo (modal ao selecionar pedido) =====
  const salvarRomaneioELote = () => {
    const r = String(tmpRomaneio || '').trim()
    const list = (tmpLotesExt || []).map(v => String(v || '').trim()).filter(v => v)
    if (!r || list.length === 0) {
      alert('Informe o Número do Romaneio e pelo menos um Número de Lote (externo).')
      return
    }
    setFormData(prev => ({ ...prev, romaneioNumero: r, lotesExternos: list, loteExterno: list[0] }))
    setRomaneioAberto(false)
  }
  const cancelarRomaneioELote = () => {
    // Mantém modal aberto até preencher, pois é obrigatório para rastreabilidade
    if (!String(tmpRomaneio || '').trim() || !(tmpLotesExt || []).some(v => String(v || '').trim())) {
      alert('Essas informações são obrigatórias para rastreabilidade.')
      return
    }
    salvarRomaneioELote()
  }
  
  // Atualiza listagem de lotes conforme rack/pedido mudar (quando modal está aberto)
  useEffect(() => {
    if (rackModalAberto) buscarLotesPorRack()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rackDigitado, rackModalAberto, pedidoSeqSelecionado, lotesDB])

  // Total apontado para a ordem selecionada
  const totalApontado = useMemo(() => {
    const chave = String(formData.ordemTrabalho || '')
    if (!chave) return 0
    try {
      console.log('Calculando totalApontado para:', chave)
      console.log('ApontamentosDB:', apontamentosDB?.length || 0, 'registros')
      
      const total = (apontamentosDB || []).reduce((acc, a) => {
        const seq = String(a.ordem_trabalho || a.ordemTrabalho || a.pedido_seq || '')
        const qtd = Number(a.quantidade || a.quantidadeProduzida || 0)
        const match = seq === chave
        const etapa = String(a.etapa_embalagem || '').trim().toUpperCase()
        const matchEtapa = (modo !== 'embalagem')
          ? true
          : (!etapa || etapa === 'EMBALAGEM')
        
        if (match) {
          console.log('Match encontrado:', { seq, qtd, apontamento: a })
        }
        
        return acc + (match && matchEtapa ? (isNaN(qtd) ? 0 : qtd) : 0)
      }, 0)
      
      console.log('Total calculado:', total)
      return total
    } catch (e) {
      console.error('Erro ao calcular totalApontado:', e)
      return 0
    }
  }, [apontamentosDB, formData.ordemTrabalho])

  // Saldo para cortar = Qtd.Pedido - Qtd. Apontada
  const saldoParaCortar = useMemo(() => {
    const qtdPed = Number(formData.qtdPedido || 0)
    const saldo = qtdPed - Number(totalApontado || 0)
    return Number.isFinite(saldo) ? saldo : 0
  }, [formData.qtdPedido, totalApontado])

  // Apontamentos filtrados da ordem em tela
  const apontamentosDaOrdem = useMemo(() => {
    const chave = String(formData.ordemTrabalho || '')
    if (!chave) return []
    try {
      return (apontamentosDB || []).filter(a => {
        const seq = String(a.ordem_trabalho || a.ordemTrabalho || a.pedido_seq || '').trim()
        return seq === chave
      })
    } catch {
      return []
    }
  }, [apontamentosDB, formData.ordemTrabalho])

  const linhasTabelaDiaria = useMemo(() => {
    const dataRef = String(dataTabelaDiaria || '').trim()
    const janelaInicio = dataRef ? new Date(`${dataRef}T06:30:00`) : null
    const janelaFim = dataRef ? new Date(`${dataRef}T01:30:00`) : null
    if (janelaFim) janelaFim.setDate(janelaFim.getDate() + 1)

    return (apontamentosDB || []).filter((a) => {
      if (!dataRef) return true
      if (!a.inicio) return false
      const inicioDate = new Date(a.inicio)
      if (Number.isNaN(inicioDate.getTime())) return false
      if (janelaInicio && inicioDate < janelaInicio) return false
      if (janelaFim && inicioDate > janelaFim) return false
      return true
    }).map((a, idx) => {
      const ordem = String(a.ordem_trabalho || a.ordemTrabalho || a.pedido_seq || '').trim()
      const quantidade = Number(a.quantidade || 0)
      const qtdRefugoRow = Number(a.qtd_refugo || 0)
      
      // Calcular horas trabalhadas
      const inicioDate = a.inicio ? new Date(a.inicio) : null
      const fimDate = a.fim ? new Date(a.fim) : null
      let horasTrabalhadas = 0
      if (inicioDate && fimDate && !isNaN(inicioDate.getTime()) && !isNaN(fimDate.getTime())) {
        const diffMs = fimDate - inicioDate
        horasTrabalhadas = Math.max(0, diffMs / (1000 * 60 * 60))
      }
      
      // Buscar status salvo na tabela status_apontamentos
      const statusSalvo = (statusApontamentosDB || []).find(s => s.apontamento_id === a.id)
      const statusFinal = statusSalvo ? statusSalvo.status : 'Não Apontado'
      
      if (statusSalvo) {
        console.log('Status encontrado para apontamento:', {
          apontamento_id: a.id,
          status_id: statusSalvo.id,
          status: statusSalvo.status,
          ordem
        })
      }

      const produto = String(a.produto || a.codigoPerfil || '').trim()
      const cfgFerramenta = buscarCfgFerramenta(produto)
      const pesoLinear = Number(cfgFerramenta?.peso_linear || 0) || 0
      const comprimentoMm = Number(cfgFerramenta?.comprimento_mm || extrairComprimentoAcabado(produto) || 0) || 0
      const comprimentoM = comprimentoMm > 0 ? comprimentoMm / 1000 : 0
      const kgEstimado = pesoLinear > 0 && comprimentoM > 0
        ? Number((pesoLinear * comprimentoM * quantidade).toFixed(3))
        : 0
      
      const turno = calcularTurno(a.inicio)

      return {
        id: a.id || `${ordem}-${idx}`,
        original: a,
        dataInicio: formatDateTimeBR(a.inicio),
        dataFim: formatDateTimeBR(a.fim),
        turno,
        ordem,
        maquina: String(a.maquina || '').trim(),
        operador: String(a.operador || '').trim(),
        cliente: String(a.cliente || '').trim(),
        pedidoCliente: String(a.pedido_cliente || a.pedidoCliente || '').trim(),
        codigoProdutoCliente: String(a.codigo_produto_cliente || a.codigoProdutoCliente || '').trim(),
        produto,
        quantidade,
        qtdRefugo: qtdRefugoRow,
        rackPallet: String(a.rack_ou_pallet || a.rackOuPallet || '').trim(),
        rackAcabado: String(a.rack_acabado || a.rackAcabado || '').trim(),
        lote: String(a.lote || '').trim(),
        romaneio: String(a.romaneio_numero || a.romaneioNumero || '').trim(),
        nroOp: String(a.nro_op || a.nroOp || '').trim(),
        observacoes: String(a.observacoes || '').trim(),
        horasTrabalhadas: horasTrabalhadas.toFixed(2),
        totalPecas: quantidade + qtdRefugoRow,
        pesoLinear,
        comprimentoMm,
        kgEstimado,
        statusMigracao: statusFinal,
        statusSalvoId: statusSalvo?.id || null
      }
    })
  }, [apontamentosDB, dataTabelaDiaria, statusApontamentosDB, ferramentasCfg])

  const linhasTabelaDiariaFiltradas = useMemo(() => {
    const termo = String(filtroTabelaDiaria || '').trim().toLowerCase()
    const turnoSelecionado = String(turnoTabelaDiaria || '').trim()

    let linhas = linhasTabelaDiaria

    if (turnoSelecionado) {
      linhas = linhas.filter((linha) => linha.turno === turnoSelecionado)
    }

    if (!termo) return linhas
    return linhas.filter((linha) => [
      linha.dataInicio,
      linha.dataFim,
      linha.turno,
      linha.ordem,
      linha.maquina,
      linha.operador,
      linha.cliente,
      linha.pedidoCliente,
      linha.codigoProdutoCliente,
      linha.produto,
      linha.quantidade,
      linha.qtdRefugo,
      linha.rackPallet,
      linha.rackAcabado,
      linha.lote,
      linha.romaneio,
      linha.nroOp,
      linha.observacoes,
      linha.statusMigracao
    ].some((valor) => String(valor || '').toLowerCase().includes(termo)))
  }, [linhasTabelaDiaria, filtroTabelaDiaria, turnoTabelaDiaria])

  const paradasTabelaDiaria = useMemo(() => {
    const dataRef = String(dataTabelaDiaria || '').trim()
    const janelaInicio = dataRef ? new Date(`${dataRef}T06:30:00`) : null
    const janelaFim = dataRef ? new Date(`${dataRef}T01:30:00`) : null
    if (janelaFim) janelaFim.setDate(janelaFim.getDate() + 1)
    const turnoSelecionado = String(turnoTabelaDiaria || '').trim()

    return (paradasDB || []).filter((p) => {
      if (!dataRef) return true
      const inicio = p.inicio || p.inicio_timestamp
      if (!inicio) return false
      const inicioDate = new Date(inicio)
      if (Number.isNaN(inicioDate.getTime())) return false
      if (janelaInicio && inicioDate < janelaInicio) return false
      if (janelaFim && inicioDate > janelaFim) return false

      if (turnoSelecionado) {
        const turno = calcularTurno(inicio)
        if (turno !== turnoSelecionado) return false
      }

      return true
    })
  }, [paradasDB, dataTabelaDiaria, turnoTabelaDiaria])

  const resumoTabelaDiaria = useMemo(() => {
    const resumo = linhasTabelaDiariaFiltradas.reduce((acc, linha) => {
      acc.totalPecasCortadas += Number(linha.quantidade || 0) || 0
      acc.totalPecasGerais += Number(linha.totalPecas || 0) || 0
      acc.totalKgEstimado += Number(linha.kgEstimado || 0) || 0
      acc.tempoProducaoHoras += Number(linha.horasTrabalhadas || 0) || 0
      return acc
    }, { totalPecasCortadas: 0, totalPecasGerais: 0, totalKgEstimado: 0, tempoProducaoHoras: 0 })

    const tempoParadaHoras = (paradasTabelaDiaria || []).reduce((acc, p) => {
      const inicio = p.inicio || p.inicio_timestamp
      const fim = p.fim || p.fim_timestamp
      if (!inicio || !fim) return acc
      const inicioDate = new Date(inicio)
      const fimDate = new Date(fim)
      if (Number.isNaN(inicioDate.getTime()) || Number.isNaN(fimDate.getTime())) return acc
      const diffMs = Math.max(0, fimDate - inicioDate)
      return acc + diffMs / (1000 * 60 * 60)
    }, 0)

    return {
      ...resumo,
      tempoParadaHoras,
      ocorrenciasParada: paradasTabelaDiaria.length
    }
  }, [linhasTabelaDiariaFiltradas, paradasTabelaDiaria])

  const exportarTabelaDiariaExcel = () => {
    if (!linhasTabelaDiariaFiltradas.length) {
      alert('Não há apontamentos do dia para exportar.')
      return
    }

    const rows = linhasTabelaDiariaFiltradas.map((linha) => ({
      'Data Início': linha.dataInicio,
      'Data Fim': linha.dataFim,
      'Pedido/Seq': linha.ordem,
      'Operador': linha.operador,
      'Cliente': linha.cliente,
      'Pedido Cliente': linha.pedidoCliente,
      'Código Cliente': linha.codigoProdutoCliente,
      'Produto': linha.produto,
      'Quantidade': linha.quantidade,
      'Qtd. Refugo': linha.qtdRefugo,
      'Total de Peças': linha.totalPecas,
      'Peso Linear (kg/m)': linha.pesoLinear || '',
      'Comprimento (mm)': linha.comprimentoMm || '',
      'KG Estimado': linha.kgEstimado || '',
      'Total de Horas': linha.horasTrabalhadas,
      'Rack/Pallet': linha.rackPallet,
      'Rack Acabado': linha.rackAcabado || '',
      'Lote': linha.lote,
      'Observações': linha.observacoes,
      'Status': linha.statusMigracao
    }))

    const workbook = XLSX.utils.book_new()
    const worksheet = XLSX.utils.json_to_sheet(rows)
    XLSX.utils.book_append_sheet(workbook, worksheet, sanitizeSheetName(`Apont_Dia_${dataTabelaDiaria || 'Consulta'}`))
    XLSX.writeFile(workbook, `apontamentos_dia_${dataTabelaDiaria || 'consulta'}.xlsx`, { compression: true })
  }

  const handleStatusChange = async (linha, novoStatus) => {
    try {
      console.log('Alterando status:', {
        apontamento_id: linha.original.id,
        statusSalvoId: linha.statusSalvoId,
        novoStatus,
        statusAtual: linha.statusMigracao
      })

      // Atualizar cache local imediatamente para feedback visual
      setStatusLocalCache(prev => ({
        ...prev,
        [linha.original.id]: novoStatus
      }))

      if (linha.statusSalvoId) {
        // Atualizar status existente
        console.log('Atualizando status existente:', linha.statusSalvoId)
        await updateStatusApont(linha.statusSalvoId, { 
          status: novoStatus,
          atualizado_em: new Date().toISOString(),
          atualizado_por: user?.nome || 'Sistema'
        })
      } else {
        // Criar novo registro de status
        console.log('Criando novo registro de status para:', linha.original.id)
        await addStatusApont({
          apontamento_id: linha.original.id,
          status: novoStatus,
          criado_em: new Date().toISOString(),
          criado_por: user?.nome || 'Sistema'
        })
      }
      
      // Forçar recarregamento dos status para atualizar a interface
      console.log('Recarregando status...')
      await recarregarStatusApontamentos()
      
      console.log('Status salvo com sucesso:', linha.id, ':', novoStatus)
    } catch (error) {
      console.error('Erro ao salvar status:', error)
      // Reverter cache local em caso de erro
      setStatusLocalCache(prev => {
        const novo = { ...prev }
        delete novo[linha.original.id]
        return novo
      })
      alert('Erro ao salvar status. Tente novamente.')
    }
  }

  const handleReimprimirEtiquetas = async (linha, tipo = 'etiquetas') => {
    try {
      const impressoraTermica = getConfiguracaoImpressoras().termica

      if (!isImpressoraAtiva('termica')) {
        alert('Impressora térmica não está configurada ou ativa. Vá em Configurações > Impressoras para configurar.')
        return
      }

      if (!impressoraTermica?.ip) {
        alert('Impressora térmica sem IP configurado. Vá em Configurações > Impressoras e preencha o IP.')
        return
      }

      const apontamento = linha.original
      
      if (tipo === 'formulario') {
        // Imprimir formulário de identificação
        const cliente = apontamento.cliente || ''
        const item = apontamento.produto || apontamento.codigoPerfil || ''
        const medida = apontamento.comprimento_acabado_mm 
          ? `${apontamento.comprimento_acabado_mm} mm`
          : extrairComprimentoAcabado(item)
        const pedidoTecno = apontamento.ordemTrabalho
          || apontamento.ordem_trabalho
          || apontamento.pedido_seq
          || apontamento.ordem
          || ''
        const pedidoCli = apontamento.pedido_cliente || apontamento.pedidoCliente || ''
        const codigoCliente = apontamento.codigo_produto_cliente || apontamento.codigoProdutoCliente || ''
        const qtde = apontamento.quantidade || ''
        const pallet = apontamento.rack_acabado || apontamento.rackAcabado || ''
        const lote = apontamento.lote || ''
        const loteMPVal = apontamento.lote_externo || apontamento.loteExterno || 
          (Array.isArray(apontamento.lotes_externos) ? apontamento.lotes_externos.join(', ') : '') || ''
        const durezaVal = (apontamento.dureza_material && String(apontamento.dureza_material).trim())
          ? apontamento.dureza_material
          : 'N/A'
        const dataHoraProducao = apontamento.inicio
          || apontamento.data_inicio
          || apontamento.dataInicio
          || apontamento.dataFim
          || apontamento.data_fim
          || ''
        const dataProducao = dataHoraProducao ? new Date(dataHoraProducao).toLocaleDateString('pt-BR') : ''
        const turno = apontamento.turno || ''

        const nomeKit = resolverNomeKit(item, kitsDB, kitComponentesDB)
        const html = buildFormularioIdentificacaoHtml({
          lote,
          loteMP: loteMPVal,
          cliente,
          item,
          codigoCliente,
          nomeKit,
          medida,
          pedidoTecno,
          pedidoCli,
          qtde,
          pallet,
          dureza: durezaVal,
          dataProducao,
          dataHoraProducao,
          turno
        })

        // Abrir em nova janela para impressão
        const printWindow = window.open('', '_blank')
        printWindow.document.write(html)
        printWindow.document.close()
        
        // Aguardar carregamento e abrir diálogo de impressão
        printWindow.onload = () => {
          setTimeout(() => {
            printWindow.print()
          }, 250)
        }

        alert('Janela de impressão aberta. Selecione a impressora desejada.')
      } else if (tipo === 'etiqueta_palete') {
        // Imprimir etiqueta de palete 100x150mm
        const pallet = apontamento.rack_acabado || apontamento.rackAcabado || apontamento.rack_ou_pallet || apontamento.rackOuPallet || ''
        const lote = extrairLoteExtrusao(apontamento)
        const loteMP = extrairLoteMP(apontamento)
        const ferramenta = extrairFerramenta(apontamento.produto || apontamento.codigoPerfil || '')
        const nomeCliente = apontamento.cliente || apontamento.nome_cliente || ''
        const codigoCliente = apontamento.codigo_produto_cliente || apontamento.codigoProdutoCliente || ''
        const comprimentoAcabado = extrairComprimentoAcabado(apontamento.produto || apontamento.codigoPerfil || '')
        const pedidoSeq = String(apontamento.ordemTrabalho || apontamento.ordem_trabalho || apontamento.pedido_seq || '').trim()
        const pedidoCliente = apontamento.pedido_cliente || ''
        const quantidade = apontamento.quantidade || ''
        const material = '6060-T6' // Padrão, pode ser configurável no futuro
        
        // Obter nome da máquina em vez do ID
        const maquinaObj = maquinas.find(m => m.id === apontamento.maquina)
        const maquina = maquinaObj ? maquinaObj.nome : apontamento.maquina || ''
        
        const operador = apontamento.operador || ''
        
        // Gerar ID único para o palete
        const agora = new Date()
        const dia = String(agora.getDate()).padStart(2, '0')
        const mes = String(agora.getMonth() + 1).padStart(2, '0')
        const ano = agora.getFullYear()
        const sequencial = String(Math.floor(Math.random() * 1000000)).padStart(6, '0')
        const idPalete = `PAL-${ano}-${mes}-${dia}-${sequencial}`
        
        // Gerar QR Code com dados completos
        const qrData = {
          id: idPalete,
          codigo_produto: apontamento.produto || apontamento.codigoPerfil || '',
          descricao: `${ferramenta} - ${comprimentoAcabado}mm`,
          cliente: nomeCliente,
          pedido: pedidoSeq,
          quantidade: quantidade,
          unidade: 'PC',
          lote: lote,
          data_producao: agora.toISOString().split('T')[0],
          material: material,
          maquina: maquina,
          status: 'PRODUZIDO',
          fifo: 'ÁREA A',
          validade: new Date(agora.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] // 1 ano
        }
        
        const qrCodeTexto = JSON.stringify(qrData)
        
        // Gerar TSPL para etiqueta de palete 100x150mm
        const tspl = PrintService.gerarEtiquetaPaleteTspl({
          larguraEtiquetaMm: 100,
          alturaEtiquetaMm: 150,
          gapEtiquetaMm: Number(impressoraTermica.gapEtiquetaMm ?? 3),
          idPalete,
          codigoProduto: apontamento.produto || apontamento.codigoPerfil || '',
          descricao: `${ferramenta} - ${comprimentoAcabado}mm`,
          cliente: nomeCliente,
          codigoCliente: codigoCliente,
          pedido: pedidoSeq,
          quantidade: quantidade,
          lote: lote,
          loteMP: loteMP || '',
          rack: pallet,
          material: material,
          maquina: maquina,
          operador: operador,
          dataProducao: agora.toLocaleDateString('pt-BR'),
          qrCode: qrCodeTexto,
          tipo: tipoPaleteManual,
          fifo: fifoPaleteManual
        })

        await PrintService.enviarTspl({
          tipo: impressoraTermica.tipo || 'local_print_service',
          ip: impressoraTermica.ip || '',
          porta: Number(impressoraTermica.porta || 9100),
          portaCom: impressoraTermica.portaCom || '',
          caminhoCompartilhada: impressoraTermica.caminhoCompartilhada || '',
          nomeImpressora: impressoraTermica.nomeImpressora || impressoraTermica.nome || 'TSC TE200',
          tspl
        })

        alert('Etiqueta de palete impressa com sucesso!')
      } else {
        // Validar distribuição
        const parseNum = (v) => {
          if (v === undefined || v === null || v === '') return 0
          const n = Number(String(v).replace(',', '.'))
          return Number.isFinite(n) ? n : 0
        }

        let dist = reimpressaoDistribuicao
          .map((item) => ({
            qtdPorEtiqueta: parseNum(item.qtdPorEtiqueta),
            qtdEtiquetas: parseNum(item.qtdEtiquetas)
          }))
          .filter((d) => d.qtdPorEtiqueta > 0 && d.qtdEtiquetas > 0)

        const qtdTotal = parseNum(apontamento.quantidade)
        if (dist.length === 0) {
          dist = [{ qtdPorEtiqueta: qtdTotal, qtdEtiquetas: 1 }]
        }

        const soma = dist.reduce((acc, d) => acc + d.qtdPorEtiqueta * d.qtdEtiquetas, 0)
        if (soma !== qtdTotal) {
          alert(`A soma das etiquetas (${soma}) não bate com a quantidade do apontamento (${qtdTotal}). Ajuste a distribuição.`)
          return
        }

        // Imprimir etiqueta térmica
        const pallet = apontamento.rack_acabado || apontamento.rackAcabado || apontamento.rack_ou_pallet || apontamento.rackOuPallet || ''
        const lote = extrairLoteExtrusao(apontamento).lote || ''
        const durezaDisplay = (apontamento.dureza_material && String(apontamento.dureza_material).trim()) ? apontamento.dureza_material : 'N/A'
        const loteMP = apontamento.lote_externo || apontamento.loteExterno || ''
        const ferramenta = extrairFerramenta(apontamento.produto || apontamento.codigoPerfil || '')
        const nomeCliente = apontamento.cliente || apontamento.nome_cliente || ''
        const comprimentoAcabado = extrairComprimentoAcabado(apontamento.produto || apontamento.codigoPerfil || '')
        const pedidoSeq = String(apontamento.ordemTrabalho || apontamento.ordem_trabalho || apontamento.pedido_seq || '').trim()

        const totalEtiquetasGeral = dist.reduce((acc, d) => acc + d.qtdEtiquetas, 0)
        let etiquetaAtualGeral = 1

        for (const pacote of dist) {
          for (let i = 0; i < pacote.qtdEtiquetas; i++) {
            const tspl = PrintService.gerarEtiquetaTspl({
              larguraEtiquetaMm: Number(impressoraTermica.larguraEtiquetaMm || 100),
              alturaEtiquetaMm: Number(impressoraTermica.alturaEtiquetaMm || 45),
              gapEtiquetaMm: Number(impressoraTermica.gapEtiquetaMm ?? 3),
              lote,
              loteMP: loteMP || '',
              rack: pallet,
              qtde: pacote.qtdPorEtiqueta || '',
              ferramenta,
              dureza: durezaDisplay,
              numeroEtiqueta: etiquetaAtualGeral,
              totalEtiquetas: totalEtiquetasGeral,
              codigoProdutoCliente: '',
              nomeCliente: nomeCliente || '',
              comprimento: comprimentoAcabado || apontamento.comprimento || apontamento.comp || '',
              pedidoCliente: apontamento.pedido_cliente || '',
              pedidoSeq
            })

            await PrintService.enviarTspl({
              tipo: impressoraTermica.tipo || 'local_print_service',
              ip: impressoraTermica.ip || '',
              porta: Number(impressoraTermica.porta || 9100),
              portaCom: impressoraTermica.portaCom || '',
              caminhoCompartilhada: impressoraTermica.caminhoCompartilhada || '',
              nomeImpressora: impressoraTermica.nomeImpressora || impressoraTermica.nome || 'TSC TE200',
              tspl
            })

            etiquetaAtualGeral++
            
            // Pausa entre envios para evitar saturação
            if (totalEtiquetasGeral > 1) {
              await new Promise(r => setTimeout(r, 500))
            }
          }
        }

        alert('Etiquetas reimprimidas com sucesso!')
      }

      setMenuReimpressaoAberto(null)
    } catch (error) {
      console.error('Erro ao reimprir:', error)
      alert('Erro ao reimprir. Tente novamente.')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-gray-800">{tituloPagina}</h1>
          
          {/* Destaque de Ferramenta e Comprimento */}
          {formData.codigoPerfil && (
            <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-md px-3 py-1.5 shadow-sm">
              <div className="flex flex-col text-xs leading-tight">
                <span className="text-blue-600 font-semibold uppercase tracking-wider">Ferramenta</span>
                <span className="text-gray-800 font-bold text-base">{extrairFerramenta(formData.codigoPerfil) || '-'}</span>
              </div>
              <div className="h-8 w-px bg-blue-200 mx-1"></div>
              <div className="flex flex-col text-xs leading-tight">
                <span className="text-blue-600 font-semibold uppercase tracking-wider">Perfil Longo</span>
                <span className="text-gray-800 font-bold text-sm mt-0.5">{extrairComprimentoLongoMm(formData.perfilLongo) || '-'}</span>
              </div>
              <div className="h-8 w-px bg-blue-200 mx-1"></div>
              <div className="flex flex-col text-xs leading-tight">
                <span className="text-green-600 font-semibold uppercase tracking-wider">Acabado</span>
                <span className="text-gray-800 font-bold text-sm mt-0.5">{extrairComprimentoAcabado(formData.codigoPerfil) ? `${extrairComprimentoAcabado(formData.codigoPerfil)} mm` : '-'}</span>
              </div>
            </div>
          )}
          
          {/* Miniatura da Foto da Ferramenta */}
          {formData.codigoPerfil && (
            <div className="flex items-center">
              {fotoUrlAtual ? (
                <div
                  className="relative group cursor-pointer"
                  onClick={() => {
                    setFotoUrlVisualizacao(fotoUrlAtual)
                    setFotoModalAberta(true)
                  }}
                  title="Clique para ampliar a foto do perfil"
                >
                  <div className="w-14 h-14 rounded-xl border-2 border-gray-300 overflow-hidden shadow-lg transition-all duration-300 group-hover:border-blue-400 group-hover:shadow-xl group-hover:scale-105">
                    <img
                      src={fotoUrlAtual}
                      alt="Foto do perfil"
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        e.target.style.display = 'none'
                        e.target.nextSibling.style.display = 'flex'
                      }}
                    />
                    <div className="w-full h-full items-center justify-center bg-gradient-to-br from-gray-100 to-gray-200" style={{display: 'none'}}>
                      <FaImage className="text-gray-400 text-xl" />
                    </div>
                  </div>
                  
                  {/* Indicador de hover */}
                  <div className="absolute inset-0 rounded-xl bg-black bg-opacity-0 group-hover:bg-opacity-20 transition-all duration-300 flex items-center justify-center">
                    <div className="w-8 h-8 bg-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transform scale-0 group-hover:scale-100 transition-all duration-300 shadow-lg">
                      <FaImage className="text-blue-600 text-sm" />
                    </div>
                  </div>
                  
                  {/* Badge de foto carregada */}
                  <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-white shadow-sm"></div>
                </div>
              ) : (
                <div
                  className="relative group cursor-pointer"
                  onClick={() => {
                    if (isAdmin() || user?.nivel_acesso?.toLowerCase().includes('super')) {
                      fileInputRef.current?.click()
                    } else {
                      alert('Apenas administradores ou supervisores podem adicionar fotos.')
                    }
                  }}
                  title="Clique para adicionar foto do perfil"
                >
                  <div className="w-14 h-14 rounded-xl border-2 border-dashed border-gray-300 flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 transition-all duration-300 group-hover:border-blue-400 group-hover:bg-gradient-to-br group-hover:from-blue-50 group-hover:to-blue-100 group-hover:shadow-md">
                    <FaImage className="text-gray-400 text-xl group-hover:text-blue-500 transition-colors duration-300" />
                  </div>
                  
                  {/* Indicador de upload */}
                  <div className="absolute inset-0 rounded-xl bg-black bg-opacity-0 group-hover:bg-opacity-10 transition-all duration-300 flex items-center justify-center">
                    <div className="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transform scale-0 group-hover:scale-100 transition-all duration-300">
                      <FaUpload className="text-white text-xs" />
                    </div>
                  </div>
                </div>
              )}
              
              {/* Input de arquivo oculto para upload */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files[0]
                  if (file) {
                    handleUploadFotoCabecalho(file)
                  }
                }}
              />
            </div>
          )}
        </div>
        
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            className="btn-primary flex items-center gap-2"
            title="Abrir tabela diária de apontamentos"
            onClick={() => setTabelaDiariaAberta(true)}
          >
            <FaListUl />
            <span>Tabela do Dia</span>
          </button>
          <button
            type="button"
            className="px-4 py-2 rounded bg-orange-500 text-white font-medium hover:bg-orange-600 transition flex items-center gap-2 text-sm"
            title="Buscar Rack/Embalagem por código do Produto"
            onClick={() => {
              setBuscarRackProdutoAberto(true)
              setCodigoProdutoBusca('')
            }}
          >
            <FaBox /> Rack!Embalagem
          </button>
        </div>
      </div>
      
      <div className="bg-white rounded-lg shadow p-4 form-compact">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-gray-700">{subtituloForm}</h2>
            <button
              type="button"
              className="p-1.5 rounded text-gray-300 hover:bg-blue-50 hover:text-blue-500 transition-colors"
              title="Reimprimir formulário por Rack Acabado"
              onClick={() => {
                setReimpRackAberto(true)
                setReimpRackBusca('')
                setReimpRackResultado(null)
                setReimpRackEditando(false)
                setReimpRackForm({})
              }}
              aria-label="Reimprimir formulário"
            >
              <FaPrint className="w-3.5 h-3.5" />
            </button>
          </div>
          {formData.ordemTrabalho && (
            <div className="flex items-center gap-2">
              <div
                className="px-3 py-1 rounded-md bg-primary-50 text-primary-700 text-sm font-semibold border border-primary-200"
                title="Soma de apontamentos desta ordem"
              >
                Qtd. Apontada: {totalApontado}
              </div>
              <div
                className="px-3 py-1 rounded-md bg-amber-50 text-amber-700 text-sm font-semibold border border-amber-200"
                title="Saldo para cortar = Qtd.Pedido - Qtd. Apontada"
              >
                Saldo p/ Cortar: {saldoParaCortar}
              </div>
              <button
                type="button"
                className="p-2 rounded border border-red-200 text-red-600 hover:bg-red-50 hover:text-red-800"
                title="Apontar peça morta vinculada ao pedido/lote atual"
                onClick={() => {
                  if (!formData.ordemTrabalho) { alert('Selecione um Pedido/Seq antes de apontar peça morta.'); return }
                  if (!formData.codigoPerfil) { alert('Selecione o produto antes de apontar peça morta.'); return }
                  setPecaMortaQtd('')
                  setPecaMortaMotivo('')
                  setPecaMortaTexto('')
                  setPecaMortaAberto(true)
                }}
                aria-label="Apontar peça morta"
              >
                <FaSkullCrossbones />
              </button>
              <button
                type="button"
                className="p-2 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                title="Ver apontamentos deste pedido"
                onClick={() => setListarApontAberto(true)}
                aria-label="Ver apontamentos do pedido"
              >
                <FaListUl />
              </button>
            </div>
          )}
      {/* Modal: Procurar por Amarrado */}
      {buscarAmarradoAberto && (
        <div className="fixed inset-0 z-[67] flex items-center justify-center">
          <div className="absolute inset-0 bg-black bg-opacity-30" onClick={() => setBuscarAmarradoAberto(false)}></div>
          <div className="relative bg-white rounded-lg shadow-lg w-full max-w-7xl h-[90vh] p-5 form-compact flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base font-semibold text-gray-800">Procurar Amarrados</h3>
              <button className="text-sm text-gray-600 hover:text-gray-900" onClick={() => setBuscarAmarradoAberto(false)}>Fechar</button>
            </div>
            {/* Layout em duas colunas */}
            <div className="flex-1 flex gap-4 min-h-0">
              {/* Coluna esquerda - Busca */}
              <div className="flex-1 flex flex-col space-y-3">
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="block label-sm font-medium text-gray-700 mb-1">Número do Amarrado</label>
                    <input
                      type="text"
                      className="input-field input-field-sm w-full"
                      value={numeroAmarrado}
                      onChange={(e)=> setNumeroAmarrado(e.target.value)}
                      placeholder="Digite o nº do amarrado (pode colar parcial)"
                      onKeyPress={(e) => e.key === 'Enter' && procurarRackPorAmarrado()}
                    />
                  </div>
                  <button type="button" className="btn-primary" onClick={procurarRackPorAmarrado}>Procurar</button>
                  <button 
                    type="button" 
                    className="btn-outline" 
                    onClick={() => { setNumeroAmarrado(''); setResultadosAmarrado([]); setAmarradosSelecionadosBusca([]) }}
                  >
                    Limpar
                  </button>
                </div>
                
                {resultadosAmarrado.length > 0 && (
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-sm text-gray-600">
                      {resultadosAmarrado.length} amarrado(s) encontrado(s) • {amarradosSelecionadosBusca.length} selecionado(s)
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={amarradosSelecionadosBusca.length === resultadosAmarrado.length && resultadosAmarrado.length > 0}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setAmarradosSelecionadosBusca(resultadosAmarrado.map((_, idx) => idx))
                          } else {
                            setAmarradosSelecionadosBusca([])
                          }
                        }}
                      />
                      Selecionar todos
                    </label>
                  </div>
                )}

                <div className="border rounded flex-1 overflow-auto">
                  {(!resultadosAmarrado || resultadosAmarrado.length === 0) && (
                    <div className="text-sm text-gray-500 p-4 text-center">
                      {numeroAmarrado ? 'Nenhum amarrado encontrado.' : 'Informe o número do amarrado e clique em Procurar.'}
                    </div>
                  )}
                  
                  {resultadosAmarrado.length > 0 && (
                    <table className="min-w-full text-xs">
                      <thead className="bg-gray-50 text-gray-600 sticky top-0">
                        <tr>
                          <th className="p-2 w-8"></th>
                          <th className="p-2 text-left">Rack/Embalagem</th>
                          <th className="p-2 text-left">Código</th>
                          <th className="p-2 text-left">Lote</th>
                          <th className="p-2 text-left">Produto</th>
                          <th className="p-2 text-left">Pedido/Seq</th>
                          <th className="p-2 text-left">Romaneio</th>
                          <th className="p-2 text-right">Qt Kg</th>
                          <th className="p-2 text-right">Qtd PC</th>
                        </tr>
                      </thead>
                      <tbody>
                        {resultadosAmarrado.map((amarrado, idx) => (
                          <tr key={idx} className="border-t hover:bg-gray-50">
                            <td className="p-2 text-center">
                              <input
                                type="checkbox"
                                checked={amarradosSelecionadosBusca.includes(idx)}
                                onChange={() => {
                                  setAmarradosSelecionadosBusca(prev => 
                                    prev.includes(idx) 
                                      ? prev.filter(i => i !== idx)
                                      : [...prev, idx]
                                  )
                                }}
                              />
                            </td>
                            <td className="p-2 font-semibold">{amarrado.rack || '-'}</td>
                            <td className="p-2">{amarrado.codigo || '-'}</td>
                            <td className="p-2">{amarrado.lote || '-'}</td>
                            <td className="p-2">{amarrado.produto || '-'}</td>
                            <td className="p-2">{amarrado.pedido_seq || '-'}</td>
                            <td className="p-2">{amarrado.romaneio || '-'}</td>
                            <td className="p-2 text-right">{Number.isFinite(amarrado.qt_kg) ? amarrado.qt_kg : '-'}</td>
                            <td className="p-2 text-right">{Number.isFinite(amarrado.qtd_pc) ? amarrado.qtd_pc : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {/* Coluna direita - Amarrados Selecionados */}
              <div className="w-80 flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-semibold text-gray-800">Amarrados Selecionados ({amarradosAcumulados.length})</h4>
                  {amarradosAcumulados.length > 0 && (
                    <button
                      type="button"
                      className="text-xs text-red-600 hover:text-red-800"
                      onClick={() => {
                        if (window.confirm('Deseja limpar todos os amarrados selecionados?')) {
                          setAmarradosAcumulados([])
                          setLotesEncontrados([])
                          setLotesSelecionados([])
                        }
                      }}
                    >
                      Limpar todos
                    </button>
                  )}
                </div>
                <div className="border rounded bg-gray-50 flex-1 overflow-auto p-3">
                  {amarradosAcumulados.length === 0 && (
                    <div className="text-sm text-gray-500 text-center py-8">
                      Nenhum amarrado selecionado ainda.
                    </div>
                  )}
                  <div className="space-y-2">
                    {amarradosAcumulados.map((amarrado, idx) => (
                      <div key={idx} className="bg-white border rounded p-2 text-xs">
                        <div className="font-semibold">Lote: {amarrado.lote}</div>
                        <div className="text-gray-600 mt-1">
                          <div>Rack: <span className="font-semibold text-blue-600">{amarrado.rack}</span></div>
                          <div>Produto: {amarrado.produto}</div>
                          <div>Pedido/Seq: {amarrado.pedido_seq}</div>
                          <div>Romaneio: {amarrado.romaneio}</div>
                        </div>
                        <button
                          type="button"
                          className="mt-1 text-red-500 hover:text-red-700 text-xs"
                          onClick={() => {
                            // Remove este amarrado específico
                            const novoAcumulados = amarradosAcumulados.filter((_, i) => i !== idx)
                            setAmarradosAcumulados(novoAcumulados)
                            
                            // Remove dos lotes selecionados também
                            setLotesSelecionados(prev => prev.filter(l => l !== amarrado.lote))
                            setLotesEncontrados(prev => prev.filter(l => l.lote !== amarrado.lote))
                          }}
                        >
                          Remover
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {modo === 'embalagem' && formData.processoEmbalagem === 'rebarbar_embalar' && (
              <div>
                <label className="block label-sm font-medium text-gray-700 mb-1">Etapa</label>
                <select
                  name="etapaEmbalagem"
                  value={formData.etapaEmbalagem}
                  onChange={handleChange}
                  required
                  className="input-field input-field-sm"
                >
                  <option value="REBARBAR_LIMPEZA">Rebarbar/Limpeza</option>
                  <option value="EMBALAGEM">Embalagem</option>
                </select>
              </div>
            )}
            
            <div className="mt-4 flex justify-between">
              <div className="flex gap-2">
                <button 
                  type="button" 
                  className="btn-outline" 
                  onClick={() => setBuscarAmarradoAberto(false)}
                >
                  Cancelar
                </button>
              </div>
              <div className="flex gap-2">
                <button 
                  type="button" 
                  className="btn-primary"
                  onClick={salvarAmarradosSelecionados}
                  disabled={amarradosSelecionadosBusca.length === 0}
                >
                  Adicionar à Seleção ({amarradosSelecionadosBusca.length})
                </button>
                <button 
                  type="button" 
                  className="btn-success"
                  onClick={() => setBuscarAmarradoAberto(false)}
                  disabled={amarradosAcumulados.length === 0}
                >
                  Finalizar ({amarradosAcumulados.length} lotes)
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {tabelaDiariaAberta && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black bg-opacity-30" onClick={() => setTabelaDiariaAberta(false)}></div>
          <div className="relative bg-white rounded-lg shadow-lg w-[99vw] max-w-[99vw] max-h-[92vh] overflow-hidden p-4 form-compact">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <h3 className="text-base font-semibold text-gray-800">Tabela Diária de Apontamentos</h3>
                <p className="text-xs text-gray-500 mt-1">Consulta diária em formato semelhante à planilha.</p>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" className="btn-secondary" onClick={exportarTabelaDiariaExcel}>Exportar Excel</button>
                <button className="text-sm text-gray-600 hover:text-gray-900" onClick={() => setTabelaDiariaAberta(false)}>Fechar</button>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-[220px_180px_1fr] gap-3 mb-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Data</label>
                <input type="date" className="input-field input-field-sm" value={dataTabelaDiaria} onChange={(e) => setDataTabelaDiaria(e.target.value)} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Turno</label>
                <select
                  className="input-field input-field-sm"
                  value={turnoTabelaDiaria}
                  onChange={(e) => setTurnoTabelaDiaria(e.target.value)}
                >
                  <option value="">Todos os turnos</option>
                  <option value="TB">TB (06:30-16:10)</option>
                  <option value="TC">TC (16:01-01:30)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Filtro</label>
                <input type="text" className="input-field input-field-sm" placeholder="Filtrar por pedido, cliente, máquina, operador, lote..." value={filtroTabelaDiaria} onChange={(e) => setFiltroTabelaDiaria(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
              <div className="rounded border bg-gray-50 px-3 py-2">
                <div className="text-xs text-gray-500">PCS Cortadas</div>
                <div className="text-lg font-semibold text-gray-800">{Number(resumoTabelaDiaria.totalPecasCortadas || 0).toLocaleString('pt-BR')}</div>
              </div>
              <div className="rounded border bg-gray-50 px-3 py-2">
                <div className="text-xs text-gray-500">KG Estimado</div>
                <div className="text-lg font-semibold text-gray-800">{Number(resumoTabelaDiaria.totalKgEstimado || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 3 })}</div>
              </div>
              <div className="rounded border bg-gray-50 px-3 py-2">
                <div className="text-xs text-gray-500">Tempo Produção</div>
                <div className="text-lg font-semibold text-gray-800">{Number(resumoTabelaDiaria.tempoProducaoHoras || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} h</div>
              </div>
              <div className="rounded border bg-gray-50 px-3 py-2">
                <div className="text-xs text-gray-500">Paradas</div>
                <div className="text-lg font-semibold text-gray-800">{Number(resumoTabelaDiaria.tempoParadaHoras || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} h</div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <button
                    type="button"
                    className="text-[11px] text-blue-600 hover:text-blue-800 hover:underline"
                    onClick={() => {
                      const dataRef = String(dataTabelaDiaria || '').trim()
                      const params = new URLSearchParams()
                      if (dataRef) params.set('data', dataRef)
                      if (turnoTabelaDiaria) params.set('turno', turnoTabelaDiaria)
                      navigate(`/apontamentos-paradas?${params.toString()}`)
                    }}
                  >
                    {resumoTabelaDiaria.ocorrenciasParada || 0} ocorrência(s)
                  </button>
                  {resumoTabelaDiaria.ocorrenciasParada > 0 && (
                    <button
                      type="button"
                      title="Ver gráfico por tipo de parada"
                      onClick={() => setGraficoParadasAberto(true)}
                      className="text-orange-500 hover:text-orange-700 transition"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M3 3h2v18H3V3zm4 7h2v11H7V10zm4-4h2v15h-2V6zm4 2h2v13h-2V8zm4-5h2v18h-2V3z"/>
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="max-h-[60vh] overflow-auto border rounded">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 sticky top-0 z-10">
                  <tr>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Status</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Data Início</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Data Fim</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Turno</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Pedido/Seq</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Operador</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Cliente</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Pedido Cliente</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Código Cliente</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Produto</th>
                    <th className="text-right px-3 py-2 whitespace-nowrap">Qtd.</th>
                    <th className="text-right px-3 py-2 whitespace-nowrap">Refugo</th>
                    <th className="text-right px-3 py-2 whitespace-nowrap">Total Peças</th>
                    <th className="text-right px-3 py-2 whitespace-nowrap">KG Est.</th>
                    <th className="text-right px-3 py-2 whitespace-nowrap">Total Horas</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Rack/Pallet</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Rack Acabado</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Lote</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Observações</th>
                    <th className="text-center px-3 py-2 whitespace-nowrap">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {linhasTabelaDiariaFiltradas.map((linha) => {
                    const statusAtual = statusLocalCache[linha.original.id] !== undefined ? statusLocalCache[linha.original.id] : linha.statusMigracao
                    const naoApontado = statusAtual === 'Não Apontado'
                    return (
                    <tr key={linha.id} className={`border-t align-top transition-colors ${naoApontado ? 'bg-amber-50 hover:bg-amber-100 border-l-4 border-l-orange-400' : 'hover:bg-gray-50'}`}>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <select
                          className={`text-xs border rounded px-2 py-1 font-semibold ${naoApontado ? 'bg-orange-100 border-orange-400 text-orange-800' : 'bg-green-50 border-green-400 text-green-800'}`}
                          value={statusAtual}
                          onChange={(e) => handleStatusChange(linha, e.target.value)}
                        >
                          <option value="Apontado">Apontado</option>
                          <option value="Não Apontado">Não Apontado</option>
                        </select>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{linha.dataInicio}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{linha.dataFim}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-semibold text-blue-700">{linha.turno || '-'}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-medium">{linha.ordem}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{linha.operador}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{linha.cliente}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{linha.pedidoCliente}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{linha.codigoProdutoCliente}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{linha.produto}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{linha.quantidade}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{linha.qtdRefugo}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{linha.totalPecas}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{linha.kgEstimado ? Number(linha.kgEstimado).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 3 }) : '-'}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{linha.horasTrabalhadas}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{linha.rackPallet}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{linha.rackAcabado || '-'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{linha.lote}</td>
                      <td className="px-3 py-2 min-w-[160px]">{linha.observacoes}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-center">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => {
                              setApontamentoPreview(linha.original)
                              setEtiquetaPreviewAberta(true)
                            }}
                            className="p-2 text-green-600 hover:bg-green-50 rounded transition"
                            title="Visualizar etiqueta"
                          >
                            <FaEye className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => {
                              setMenuReimpressaoAberto(linha)
                              setReimpressaoDistribuicao([{ qtdPorEtiqueta: linha.quantidade || '', qtdEtiquetas: '1' }])
                            }}
                            className="p-2 text-blue-600 hover:bg-blue-50 rounded transition"
                            title="Reimprimir etiqueta ou formulário"
                          >
                            <FaPrint className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )})}  
                  {linhasTabelaDiariaFiltradas.length === 0 && (
                    <tr>
                      <td colSpan="19" className="px-3 py-6 text-center text-gray-500">Nenhum apontamento encontrado para a data selecionada</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Popup: Gráfico de Paradas por Tipo */}
      {graficoParadasAberto && (() => {
        const cores = ['#f97316','#3b82f6','#10b981','#8b5cf6','#ef4444','#eab308','#06b6d4','#ec4899','#84cc16','#6366f1']
        const totalHorasGeral = resumoTabelaDiaria.tempoParadaHoras || 0

        const grupos = {}
        ;(paradasTabelaDiaria || []).forEach(p => {
          const tipo = p.tipo_parada || 'Sem tipo'
          const inicio = p.inicio_timestamp || p.inicio
          const fim = p.fim_timestamp || p.fim
          if (!grupos[tipo]) grupos[tipo] = { count: 0, horas: 0, itens: [] }
          grupos[tipo].count += 1
          grupos[tipo].itens.push(p)
          if (inicio && fim) {
            const diff = Math.max(0, new Date(fim) - new Date(inicio)) / (1000 * 60 * 60)
            grupos[tipo].horas += diff
          }
        })

        const dados = Object.entries(grupos)
          .map(([tipo, v]) => ({
            tipo,
            count: v.count,
            horas: v.horas,
            itens: v.itens,
            pct: totalHorasGeral > 0 ? (v.horas / totalHorasGeral) * 100 : 0
          }))
          .sort((a, b) => b.horas - a.horas)

        const fmtDt = (ts) => {
          if (!ts) return '-'
          const d = new Date(ts)
          if (isNaN(d)) return '-'
          return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
        }

        const fmtDur = (p) => {
          const ini = p.inicio_timestamp || p.inicio
          const fim = p.fim_timestamp || p.fim
          if (!ini || !fim) return ''
          const diff = Math.max(0, new Date(fim) - new Date(ini)) / (1000 * 60 * 60)
          return `${diff.toFixed(2)} h`
        }

        return (
          <div className="fixed inset-0 z-[80] flex items-center justify-center">
            <div className="absolute inset-0 bg-black bg-opacity-50" onClick={() => { setGraficoParadasAberto(false); setTipoParadaExpandido(null) }} />
            <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b bg-orange-50">
                <div>
                  <h3 className="font-bold text-gray-800 text-base">Paradas por Tipo</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {resumoTabelaDiaria.ocorrenciasParada} ocorrência(s) · {totalHorasGeral.toFixed(2)} h total
                  </p>
                </div>
                <button onClick={() => { setGraficoParadasAberto(false); setTipoParadaExpandido(null) }} className="text-gray-400 hover:text-gray-700 p-1">
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/>
                  </svg>
                </button>
              </div>

              {/* Gráfico + detalhes */}
              <div className="px-5 py-4 space-y-2 max-h-[65vh] overflow-y-auto">
                {dados.length === 0 ? (
                  <p className="text-center text-gray-400 py-6 text-sm">Nenhuma parada com dados de tempo.</p>
                ) : dados.map((d, i) => {
                  const cor = cores[i % cores.length]
                  const expandido = tipoParadaExpandido === d.tipo
                  return (
                    <div key={d.tipo} className="rounded-lg border overflow-hidden" style={{ borderColor: expandido ? cor : '#e5e7eb' }}>
                      {/* Linha clicável */}
                      <div
                        className="px-3 py-2.5 cursor-pointer select-none hover:bg-gray-50 transition"
                        onClick={() => setTipoParadaExpandido(expandido ? null : d.tipo)}
                      >
                        <div className="flex justify-between items-center mb-1.5">
                          <div className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: cor }} />
                            <span className="text-sm font-medium text-gray-800">{d.tipo}</span>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-gray-500 flex-shrink-0">
                            <span className="font-semibold text-gray-700">{d.horas.toFixed(2)} h</span>
                            <span className="w-10 text-right font-bold" style={{ color: cor }}>{d.pct.toFixed(1)}%</span>
                            <span className="w-12 text-right text-gray-400">{d.count} ocor.</span>
                            <svg xmlns="http://www.w3.org/2000/svg" className={`w-3.5 h-3.5 text-gray-400 transition-transform ${expandido ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
                              <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd"/>
                            </svg>
                          </div>
                        </div>
                        <div className="w-full bg-gray-100 rounded-full h-4 overflow-hidden">
                          <div
                            className="h-4 rounded-full flex items-center justify-end pr-2 transition-all duration-500"
                            style={{ width: `${Math.max(d.pct, 2)}%`, backgroundColor: cor }}
                          >
                            {d.pct >= 10 && <span className="text-white text-[10px] font-bold">{d.pct.toFixed(0)}%</span>}
                          </div>
                        </div>
                      </div>

                      {/* Detalhes expandidos */}
                      {expandido && (
                        <div className="border-t bg-gray-50 divide-y divide-gray-100">
                          {d.itens.map((item, idx) => (
                            <div key={item.id || idx} className="px-4 py-2.5 text-xs">
                              <div className="flex justify-between items-start gap-2">
                                <div className="flex-1 min-w-0">
                                  <div className="font-semibold text-gray-700 mb-0.5">
                                    {item.motivo_parada || item.motivo || <span className="text-gray-400 italic">Motivo não informado</span>}
                                  </div>
                                  <div className="flex gap-3 text-gray-500 flex-wrap">
                                    <span>🕐 <span className="font-medium">{fmtDt(item.inicio_timestamp || item.inicio)}</span></span>
                                    <span>🕓 <span className="font-medium">{fmtDt(item.fim_timestamp || item.fim)}</span></span>
                                    {fmtDur(item) && <span className="text-orange-600 font-semibold">{fmtDur(item)}</span>}
                                  </div>
                                  {(item.observacoes || item.obs) && (
                                    <div className="mt-1 text-gray-500 italic">
                                      💬 {item.observacoes || item.obs}
                                    </div>
                                  )}
                                </div>
                                {item.maquina && (
                                  <span className="text-gray-400 flex-shrink-0">{item.maquina}</span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Footer totais */}
              <div className="px-5 py-3 border-t bg-gray-50 flex justify-between text-xs text-gray-600">
                <span><strong>{resumoTabelaDiaria.ocorrenciasParada}</strong> ocorrências no total</span>
                <span>Total: <strong>{totalHorasGeral.toFixed(2)} h</strong></span>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Modal: Menu de Reimpressão */}
      {menuReimpressaoAberto && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[70] px-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md form-compact">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                <FaPrint className="text-blue-600" />
                Opções de Reimpressão
              </h2>
              <button
                onClick={() => setMenuReimpressaoAberto(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>

            <div className="p-6 space-y-4">
              {/* Informações do Apontamento */}
              <div className="bg-gray-50 p-3 rounded border border-gray-200">
                <h3 className="text-sm font-semibold text-gray-700 mb-2">Informações do Apontamento</h3>
                <div className="space-y-1 text-sm text-gray-600">
                  <p><strong>Lote:</strong> {menuReimpressaoAberto?.lote || 'N/A'}</p>
                  <p><strong>Pedido:</strong> {menuReimpressaoAberto?.ordem || 'N/A'}</p>
                  <p><strong>Produto:</strong> {menuReimpressaoAberto?.produto || 'N/A'}</p>
                  <p><strong>Quantidade:</strong> {menuReimpressaoAberto?.quantidade || 'N/A'} PC</p>
                </div>
              </div>

              {/* Tipo de Reimpressão */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-gray-700">Tipo de Reimpressão:</h3>
                <div className="space-y-2">
                  <label className="flex items-center gap-3 p-3 border border-gray-200 rounded cursor-pointer hover:bg-blue-50" style={{ borderColor: tipoReimpressao === 'formulario' ? '#3b82f6' : '#e5e7eb', backgroundColor: tipoReimpressao === 'formulario' ? '#eff6ff' : 'white' }}>
                    <input
                      type="radio"
                      name="tipoReimpressao"
                      value="formulario"
                      checked={tipoReimpressao === 'formulario'}
                      onChange={(e) => setTipoReimpressao(e.target.value)}
                      className="w-4 h-4"
                    />
                    <div className="flex items-center gap-2">
                      <FaFileAlt className="text-blue-600" />
                      <span className="text-sm font-medium">Apenas Formulário</span>
                    </div>
                  </label>

                  <label className="flex items-center gap-3 p-3 border border-gray-200 rounded cursor-pointer hover:bg-blue-50" style={{ borderColor: tipoReimpressao === 'etiquetas' ? '#3b82f6' : '#e5e7eb', backgroundColor: tipoReimpressao === 'etiquetas' ? '#eff6ff' : 'white' }}>
                    <input
                      type="radio"
                      name="tipoReimpressao"
                      value="etiquetas"
                      checked={tipoReimpressao === 'etiquetas'}
                      onChange={(e) => setTipoReimpressao(e.target.value)}
                      className="w-4 h-4"
                    />
                    <div className="flex items-center gap-2 flex-1">
                      <FaBarcode className="text-green-600" />
                      <span className="text-sm font-medium">Etiqueta Térmica</span>
                      <select
                        value={tamanhoEtiqueta}
                        onChange={(e) => setTamanhoEtiqueta(e.target.value)}
                        className="input-field text-xs py-1 ml-auto"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <option value="100x45">100x45mm</option>
                        <option value="100x150">100x150mm</option>
                      </select>
                    </div>
                  </label>

                  <label className="flex items-center gap-3 p-3 border border-gray-200 rounded cursor-pointer hover:bg-blue-50" style={{ borderColor: tipoReimpressao === 'etiqueta_palete' ? '#3b82f6' : '#e5e7eb', backgroundColor: tipoReimpressao === 'etiqueta_palete' ? '#eff6ff' : 'white' }}>
                    <input
                      type="radio"
                      name="tipoReimpressao"
                      value="etiqueta_palete"
                      checked={tipoReimpressao === 'etiqueta_palete'}
                      onChange={(e) => setTipoReimpressao(e.target.value)}
                      className="w-4 h-4"
                    />
                    <div className="flex items-center gap-2">
                      <FaTags className="text-purple-600" />
                      <span className="text-sm font-medium">Etiqueta de Palete (100x150mm)</span>
                    </div>
                  </label>
                </div>
              </div>

              {/* Distribuição (Apenas se Etiqueta Térmica) */}
              {tipoReimpressao === 'etiquetas' && (
                <div className="space-y-3 pt-3 border-t border-gray-200 mt-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-700">Distribuição:</h3>
                    <button
                      type="button"
                      onClick={() => setReimpressaoDistribuicao([...reimpressaoDistribuicao, { qtdPorEtiqueta: '', qtdEtiquetas: '1' }])}
                      className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
                    >
                      <FaPlus /> Adicionar Linha
                    </button>
                  </div>
                  
                  <div className="space-y-2">
                    {reimpressaoDistribuicao.map((item, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <div className="flex-1">
                          <label className="block text-[10px] text-gray-500 uppercase">Qtd por Etiqueta</label>
                          <input
                            type="number"
                            className="input-field py-1 text-sm text-center"
                            value={item.qtdPorEtiqueta}
                            placeholder="Qtd"
                            onChange={(e) => {
                              const novas = [...reimpressaoDistribuicao]
                              novas[idx].qtdPorEtiqueta = e.target.value
                              setReimpressaoDistribuicao(novas)
                            }}
                          />
                        </div>
                        <div className="text-gray-400 mt-4 px-1">×</div>
                        <div className="flex-1">
                          <label className="block text-[10px] text-gray-500 uppercase">Num. Etiquetas</label>
                          <input
                            type="number"
                            className="input-field py-1 text-sm text-center"
                            value={item.qtdEtiquetas}
                            placeholder="1"
                            onChange={(e) => {
                              const novas = [...reimpressaoDistribuicao]
                              novas[idx].qtdEtiquetas = e.target.value
                              setReimpressaoDistribuicao(novas)
                            }}
                          />
                        </div>
                        <div className="w-8 pt-4">
                          {reimpressaoDistribuicao.length > 1 && (
                            <button
                              type="button"
                              onClick={() => {
                                const novas = reimpressaoDistribuicao.filter((_, i) => i !== idx)
                                setReimpressaoDistribuicao(novas)
                              }}
                              className="text-red-500 hover:text-red-700 p-1"
                              title="Remover linha"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="bg-gray-50 p-2 rounded text-xs text-gray-600 flex justify-between items-center border border-gray-200">
                    <span>
                      Soma: <strong>{reimpressaoDistribuicao.reduce((acc, d) => acc + (Number(d.qtdPorEtiqueta) || 0) * (Number(d.qtdEtiquetas) || 0), 0)} PC</strong>
                    </span>
                    <span className={reimpressaoDistribuicao.reduce((acc, d) => acc + (Number(d.qtdPorEtiqueta) || 0) * (Number(d.qtdEtiquetas) || 0), 0) === Number(menuReimpressaoAberto?.quantidade || 0) ? "text-green-600 font-medium" : "text-red-500 font-medium"}>
                      Total do Apontamento: {menuReimpressaoAberto?.quantidade || 0} PC
                    </span>
                  </div>
                </div>
              )}

              {/* Informações da Etiqueta de Palete */}
              {tipoReimpressao === 'etiqueta_palete' && (
                <div className="space-y-3 pt-3 border-t border-gray-200 mt-3">
                  <div className="bg-purple-50 p-3 rounded border border-purple-200">
                    <h3 className="text-sm font-semibold text-purple-800 mb-2">Informações da Etiqueta de Palete</h3>
                    <div className="space-y-2 text-xs text-purple-700">
                      <div className="flex justify-between">
                        <span><strong>Dimensão:</strong> 100x150mm</span>
                        <span><strong>Layout:</strong> Industrial</span>
                      </div>
                      <div className="flex justify-between">
                        <span><strong>Conteúdo:</strong> QR Code + dados completos</span>
                        <span><strong>Aplicação:</strong> Paletes e expedição</span>
                      </div>
                      <div className="mt-2 p-2 bg-purple-100 rounded text-xs text-purple-800">
                        <strong>Observação:</strong> Esta etiqueta será impressa uma única vez com todas as informações do palete, incluindo QR Code para rastreabilidade completa.
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Botões */}
            <div className="flex gap-4 p-4 bg-gray-50 border-t border-gray-200">
              <button
                onClick={() => setMenuReimpressaoAberto(null)}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded hover:bg-gray-100"
              >
                Cancelar
              </button>
              <button
                onClick={() => handleReimprimirEtiquetas({ original: menuReimpressaoAberto }, tipoReimpressao)}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 font-medium flex items-center justify-center gap-2"
              >
                <FaPrint />
                Reimprir
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Reimpressão por Rack Acabado */}
      {reimpRackAberto && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[70] px-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg form-compact">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                <FaRedo className="text-blue-500" />
                Reimprimir Formulário
              </h2>
              <button onClick={() => setReimpRackAberto(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="p-4 space-y-3">
              {/* Busca */}
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Digite o Rack Acabado (ex: USI-1314)"
                  value={reimpRackBusca}
                  onChange={(e) => setReimpRackBusca(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === 'Enter' && buscarRackParaReimpressao()}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-blue-300 focus:border-blue-400"
                  autoFocus
                />
                <button
                  onClick={buscarRackParaReimpressao}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm flex items-center gap-1"
                >
                  <FaSearch className="w-3 h-3" /> Buscar
                </button>
              </div>

              {/* Resultado: Não encontrado */}
              {reimpRackResultado === 'NOT_FOUND' && (
                <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
                  Rack não encontrado nos apontamentos carregados.
                </div>
              )}

              {/* Resultado: Encontrado */}
              {reimpRackResultado && reimpRackResultado !== 'NOT_FOUND' && (
                <>
                  <div className="bg-gray-50 border border-gray-200 rounded p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-gray-500 uppercase">Dados do Apontamento</span>
                      <button
                        type="button"
                        onClick={() => setReimpRackEditando(!reimpRackEditando)}
                        className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
                      >
                        <FaEdit className="w-3 h-3" />
                        {reimpRackEditando ? 'Cancelar edição' : 'Editar para impressão'}
                      </button>
                    </div>

                    {!reimpRackEditando ? (
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                        <div><span className="text-gray-500">Rack:</span> <strong>{reimpRackForm.rack_acabado}</strong></div>
                        <div><span className="text-gray-500">Lote:</span> <strong>{reimpRackForm.lote}</strong></div>
                        <div><span className="text-gray-500">Cliente:</span> <strong>{reimpRackForm.cliente}</strong></div>
                        <div><span className="text-gray-500">Produto:</span> <strong className="text-xs">{reimpRackForm.produto}</strong></div>
                        <div><span className="text-gray-500">Pedido:</span> <strong>{reimpRackForm.pedido_seq}</strong></div>
                        <div><span className="text-gray-500">Pedido Cli:</span> <strong>{reimpRackForm.pedido_cliente}</strong></div>
                        <div><span className="text-gray-500">Quantidade:</span> <strong>{reimpRackForm.quantidade}</strong></div>
                        <div><span className="text-gray-500">Dureza:</span> <strong>{reimpRackForm.dureza_material || 'N/A'}</strong></div>
                        <div><span className="text-gray-500">Lote Ext:</span> <strong>{reimpRackForm.lote_externo || '-'}</strong></div>
                        <div><span className="text-gray-500">Cód. Cliente:</span> <strong>{reimpRackForm.codigo_produto_cliente || '-'}</strong></div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { key: 'rack_acabado', label: 'Rack Acabado' },
                          { key: 'lote', label: 'Lote' },
                          { key: 'cliente', label: 'Cliente' },
                          { key: 'produto', label: 'Produto' },
                          { key: 'pedido_seq', label: 'Pedido/Seq' },
                          { key: 'pedido_cliente', label: 'Pedido Cliente' },
                          { key: 'quantidade', label: 'Quantidade' },
                          { key: 'dureza_material', label: 'Dureza' },
                          { key: 'lote_externo', label: 'Lote Externo' },
                          { key: 'codigo_produto_cliente', label: 'Cód. Cliente' },
                          { key: 'comprimento_acabado_mm', label: 'Medida (mm)' },
                        ].map(({ key, label }) => (
                          <div key={key}>
                            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">{label}</label>
                            <input
                              type="text"
                              value={reimpRackForm[key] || ''}
                              onChange={(e) => setReimpRackForm(prev => ({ ...prev, [key]: e.target.value }))}
                              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {reimpRackEditando && (
                    <div className="bg-amber-50 border border-amber-200 rounded p-2 text-xs text-amber-700">
                      As alterações são apenas para esta impressão e não modificam o apontamento original.
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Botões */}
            <div className="flex gap-3 p-4 bg-gray-50 border-t border-gray-200">
              <button
                onClick={() => setReimpRackAberto(false)}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded hover:bg-gray-100 text-sm"
              >
                Fechar
              </button>
              {reimpRackResultado && reimpRackResultado !== 'NOT_FOUND' && (
                <button
                  onClick={imprimirReimpRack}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 font-medium flex items-center justify-center gap-2 text-sm"
                >
                  <FaPrint className="w-3.5 h-3.5" />
                  Imprimir Formulário
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal: Peça morta (apontamento imediato) */}
      {pecaMortaAberto && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[70] px-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg form-compact">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div className="flex items-center gap-2 text-gray-800 font-semibold">
                <FaSkullCrossbones className="text-red-600" /> Peça morta (refugo imediato)
              </div>
              <button className="text-sm text-gray-500" onClick={() => setPecaMortaAberto(false)}>Fechar</button>
            </div>

            <form className="p-4 space-y-3" onSubmit={handleSalvarPecaMorta}>
              <div className="grid grid-cols-2 gap-3 text-sm text-gray-600">
                <div>
                  <div className="text-xs text-gray-500">Pedido/Seq</div>
                  <div className="font-semibold text-gray-800 break-words">{formData.ordemTrabalho || '-'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Produto</div>
                  <div className="font-semibold text-gray-800 break-words">{formData.codigoPerfil || '-'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Cliente</div>
                  <div className="font-semibold text-gray-800 break-words">{formData.cliente || '-'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Lote vinculado</div>
                  <div className="font-semibold text-gray-800 break-words">
                    {(formData.lotesExternos && formData.lotesExternos[0]) ? formData.lotesExternos[0] : (formData.loteExterno || '-')}
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-sm text-gray-700 mb-1">Quantidade (peças)</label>
                <input
                  type="number"
                  min="1"
                  className="input-field w-full"
                  value={pecaMortaQtd}
                  onChange={(e) => setPecaMortaQtd(e.target.value)}
                  disabled={pecaMortaSaving}
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700 mb-1">Motivo (lista)</label>
                  <select
                    className="input-field w-full"
                    value={pecaMortaMotivo}
                    onChange={(e) => setPecaMortaMotivo(e.target.value)}
                    disabled={pecaMortaSaving}
                  >
                    <option value="">Selecione...</option>
                    {motivosPecaMorta.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-1">Motivo (texto livre)</label>
                  <input
                    type="text"
                    className="input-field w-full"
                    placeholder="Descreva o motivo"
                    value={pecaMortaTexto}
                    onChange={(e) => setPecaMortaTexto(e.target.value)}
                    disabled={pecaMortaSaving}
                  />
                </div>
              </div>

              <p className="text-xs text-gray-500">
                É obrigatório informar um motivo (selecionar na lista ou digitar no texto livre).
              </p>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button type="button" className="btn-outline" onClick={() => setPecaMortaAberto(false)} disabled={pecaMortaSaving}>Cancelar</button>
                <button type="submit" className="btn-primary" disabled={pecaMortaSaving}>
                  {pecaMortaSaving ? 'Salvando...' : 'Salvar peça morta'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Modal: Inspecionar Amarrados do Rack */}
      {inspAberto && (
        <div className="fixed inset-0 z-[67] flex items-center justify-center">
          <div className="absolute inset-0 bg-black bg-opacity-30" onClick={()=>setInspAberto(false)}></div>
          <div className="relative bg-white rounded-lg shadow-lg w-full max-w-3xl p-6 form-compact">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-semibold text-gray-800">Amarrados no Rack {rackDigitado}</h3>
              <div className="text-xs text-gray-500">Total: {amarradosFiltrados.length}</div>
            </div>
            <div className="mb-2 flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-700">Filtro Pedido:</label>
                <input
                  type="text"
                  className="input-field input-field-sm w-36"
                  placeholder="ex.: 82647"
                  value={filtroPedidoInsp}
                  onChange={(e)=>{ setFiltroPedidoInsp(e.target.value); setMarcarTodosAmarrados(false) }}
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-700">Filtro Romaneio:</label>
                <input
                  type="text"
                  className="input-field input-field-sm w-36"
                  placeholder="ex.: 124784"
                  value={filtroRomaneioInsp}
                  onChange={(e)=>{ setFiltroRomaneioInsp(e.target.value); setMarcarTodosAmarrados(false) }}
                />
              </div>
              {(filtroPedidoInsp || filtroRomaneioInsp) && (
                <button
                  type="button"
                  className="px-2 py-1 text-xs border rounded bg-white hover:bg-gray-50"
                  onClick={()=>{ setFiltroPedidoInsp(''); setFiltroRomaneioInsp(''); setMarcarTodosAmarrados(false) }}
                >
                  Limpar filtros
                </button>
              )}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={marcarTodosAmarrados}
                  onChange={(e)=>{
                    const on = e.target.checked
                    setMarcarTodosAmarrados(on)
                    const idxs = amarradosFiltrados.map(a => a.idx)
                    setAmarradosSelecionados(on ? Array.from(new Set([...(amarradosSelecionados||[]), ...idxs])) : (amarradosSelecionados||[]).filter(i => !idxs.includes(i)))
                  }}
                />
                Selecionar todos
              </label>
            </div>
            <div className="max-h-[60vh] overflow-auto border rounded">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="p-2 w-8"></th>
                    <th className="p-2 text-left">Codigo</th>
                    <th className="p-2 text-left">Produto</th>
                    <th className="p-2 text-left">Lote</th>
                    <th className="p-2 text-left">Romaneio</th>
                    <th className="p-2 text-left">Pedido/Seq</th>
                    <th className="p-2 text-right">Qt Kg</th>
                    <th className="p-2 text-right">Qtd PC</th>
                  </tr>
                </thead>
                <tbody>
                  {amarradosFiltrados.map((a, i) => (
                    <tr key={a.idx} className="border-t">
                      <td className="p-2 text-center">
                        <input
                          type="checkbox"
                          checked={amarradosSelecionados.includes(a.idx)}
                          onChange={()=>setAmarradosSelecionados(prev => prev.includes(a.idx) ? prev.filter(x=>x!==a.idx) : [...prev, a.idx])}
                        />
                      </td>
                      <td className="p-2">{a.codigo || '-'}</td>
                      <td className="p-2">{a.produto || '-'}</td>
                      <td className="p-2">{a.lote || '-'}</td>
                      <td className="p-2">{a.romaneio || '-'}</td>
                      <td className="p-2">{a.pedido_seq || '-'}</td>
                      <td className="p-2 text-right">{Number.isFinite(a.qt_kg) ? a.qt_kg : '-'}</td>
                      <td className="p-2 text-right">{Number.isFinite(a.qtd_pc) ? a.qtd_pc : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn-outline" onClick={()=>setInspAberto(false)}>Fechar</button>
              <button
                type="button"
                className="btn-primary"
                onClick={()=>{
                  // aplica seleção de amarrados gerando seleção de lotes únicos
                  const selecionados = amarradosSelecionados.map(i => amarradosRack[i])
                  const lotes = Array.from(new Set(selecionados.map(a => String(a.lote || '').trim()).filter(Boolean)))
                  setLotesSelecionados(prev => Array.from(new Set([...prev, ...lotes])))
                  setInspAberto(false)
                }}
              >
                Aplicar seleção
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Modal: Digitar Lote de Extrusão (manual) */}
      {manualAberto && (
        <div className="fixed inset-0 z-[67] flex items-center justify-center">
          <div className="absolute inset-0 bg-black bg-opacity-30" onClick={()=>setManualAberto(false)}></div>
          <div className="relative bg-white rounded-lg shadow-lg w-full max-w-md p-5 form-compact">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base font-semibold text-gray-800">Digitar Lote de Extrusão</h3>
            </div>
            <div className="text-sm text-gray-600 mb-3">Informe um ou mais lotes, separados por vírgula, espaço ou quebra de linha.</div>
            <textarea
              className="w-full border rounded p-2 text-sm h-32"
              placeholder="Ex.: 125210022, 225390040"
              value={manualLotesTxt}
              onChange={(e)=>setManualLotesTxt(e.target.value)}
            ></textarea>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn-outline" onClick={()=>setManualAberto(false)}>Cancelar</button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  const tokens = String(manualLotesTxt || '')
                    .split(/[^0-9]+/)
                    .map(s => s.trim())
                    .filter(Boolean)
                  if (!tokens.length) { alert('Nenhum número de lote informado.'); return }
                  // adiciona na seleção do modal principal
                  setLotesSelecionados(prev => Array.from(new Set([...(prev||[]), ...tokens])))
                  setManualAberto(false)
                }}
              >
                Adicionar à seleção
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Modal: Romaneio e Lote Externo (obrigatório ao selecionar pedido) */}
      {romaneioAberto && (
        <div className="fixed inset-0 z-[65] flex items-center justify-center">
          <div className="absolute inset-0 bg-black bg-opacity-30"></div>
          <div className="relative bg-white rounded-lg shadow-lg w-full max-w-md p-5 form-compact">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base font-semibold text-gray-800">Dados para Rastreabilidade</h3>
            </div>
            <p className="text-sm text-gray-600 mb-3">Informe o <strong>Número do Romaneio</strong> e o <strong>Número do Lote (externo)</strong> do material recebido.</p>
            <div className="space-y-3">
              <div>
                <label className="block label-sm font-medium text-gray-700 mb-1">Número do Romaneio</label>
                <input type="text" className="input-field input-field-sm" value={tmpRomaneio} onChange={(e)=>setTmpRomaneio(e.target.value)} autoFocus />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block label-sm font-medium text-gray-700">Número do Lote (externo)</label>
                  <button type="button" title="Adicionar outro lote" className="p-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100" onClick={() => setTmpLotesExt(prev => [...prev, ''])}>
                    <FaPlus />
                  </button>
                </div>
                <div className="space-y-2">
                  {(tmpLotesExt || []).map((val, idx) => (
                    <input key={idx} type="text" className="input-field input-field-sm" value={val} onChange={(e)=>{
                      const v = e.target.value; setTmpLotesExt(prev => { const arr = [...prev]; arr[idx] = v; return arr })
                    }} placeholder={`Lote externo ${idx+1}`} />
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn-primary" onClick={salvarRomaneioELote}>Salvar</button>
            </div>
          </div>
        </div>
      )}
      {/* Modal: Rack!Embalagem e Lotes (novo fluxo) */}
      {rackModalAberto && (
        <div className="fixed inset-0 z-[66] flex items-center justify-center">
          <div className="absolute inset-0 bg-black bg-opacity-30"></div>
          <div className="relative bg-white rounded-lg shadow-lg w-full max-w-2xl p-6 form-compact">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base font-semibold text-gray-800">Selecionar Rack!Embalagem e Lotes</h3>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block label-sm font-medium text-gray-700 mb-1">Pedido/Seq</label>
                <input type="text" className="input-field input-field-sm" value={pedidoSeqSelecionado} readOnly />
              </div>
              <div>
                <label className="block label-sm font-medium text-gray-700 mb-1">Rack!Embalagem</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    className="input-field input-field-sm flex-1"
                    value={rackDigitado}
                    onChange={(e)=>setRackDigitado(e.target.value)}
                    placeholder="Informe o código do Rack/Embalagem"
                    autoFocus
                  />
                  <button
                    type="button"
                    className="px-3 py-1.5 text-xs rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-700"
                    title="Inspecionar amarrados do Rack"
                    onClick={() => {
                      const r = String(rackDigitado || '').trim()
                      if (!r) { alert('Informe o Rack!Embalagem primeiro.'); return }
                      
                      // Busca exata primeiro (como na versão que funcionava)
                      let lista = (lotesDB || []).filter(l => String(l.rack_embalagem || '').trim() === r)
                      
                      // Se não encontrou nada, tenta busca normalizada
                      if (lista.length === 0) {
                        const rNorm = normalizeRackId(r)
                        if (rNorm) {
                          lista = (lotesDB || []).filter(l => {
                            const lr = normalizeRackId(l.rack_embalagem)
                            if (!lr) return false
                            return lr === rNorm || (lr.endsWith(rNorm) && rNorm.length >= 3)
                          })
                        }
                      }
                      
                      const rows = lista.map((l, idx) => ({
                        idx,
                        codigo: String(l.codigo || '').trim(),
                        produto: String(l.produto || getCampoOriginalLote(l, 'Produto') || '').trim(),
                        lote: String(l.lote || '').trim(),
                        romaneio: String(l.romaneio || '').trim(),
                        pedido_seq: String(l.pedido_seq || '').trim(),
                        qt_kg: Number(l.qt_kg || 0),
                        qtd_pc: Number(l.qtd_pc || 0)
                      }))
                      setAmarradosRack(rows)
                      setAmarradosSelecionados([])
                      setMarcarTodosAmarrados(false)
                      setInspAberto(true)
                    }}
                  >
                    Inspecionar
                  </button>
                  <button
                    type="button"
                    className="px-3 py-1.5 text-xs rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-700"
                    title="Procurar o Rack pelo número do Amarrado"
                    onClick={() => { 
                      setBuscarAmarradoAberto(true); 
                      setNumeroAmarrado(''); 
                      setResultadosAmarrado([]);
                      setAmarradosSelecionadosBusca([]);
                      // Inicializa amarrados acumulados com os lotes já encontrados
                      const lotesJaEncontrados = lotesEncontrados.filter(l => l.rack).map(l => ({
                        rack: l.rack,
                        lote: l.lote,
                        produto: l.produto,
                        pedido_seq: `${l.pedido}/${l.seq}`,
                        romaneio: l.romaneio
                      }));
                      setAmarradosAcumulados(lotesJaEncontrados);
                    }}
                  >
                    Procurar por Amarrado
                  </button>
                  <button
                    type="button"
                    className="px-3 py-1.5 text-xs rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-700"
                    title="Digitar Lote de Extrusão manualmente"
                    onClick={() => { setManualAberto(true); setManualLotesTxt('') }}
                  >
                    Digitar Lote
                  </button>
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block label-sm font-medium text-gray-700">Lotes encontrados</label>
                  <div className="text-[11px] text-gray-600">
                    {(() => {
                      const qtdLotes = lotesEncontrados.length
                      const qtdAmarrados = (lotesEncontrados || []).reduce((acc, l) => acc + ((l?.amarrados?.length) || 0), 0)
                      const comprimentos = new Set((lotesEncontrados || []).map(l => String(l?.comprimentoLongoMm || '').trim()).filter(v => v))
                      const qtdComprimentos = comprimentos.size
                      return `${qtdLotes} lote(s) • ${qtdAmarrados} amarrado(s) • ${qtdComprimentos} comprimento(s)`
                    })()}
                  </div>
                </div>
                <div className="max-h-72 overflow-auto border rounded p-3 space-y-2">
                  {lotesEncontrados.length === 0 && (
                    <div className="text-sm text-gray-500">
                      {rackDigitado 
                        ? 'Nenhum lote encontrado para este Rack.'
                        : 'Informe o Rack!Embalagem ou use "Procurar por Amarrado" para adicionar lotes.'
                      }
                    </div>
                  )}
                  {lotesEncontrados.map((l) => (
                    <div key={l.lote} className="border rounded p-3 bg-gray-50">
                      <div className="flex items-start gap-3 text-sm">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={todoAmarradosDoLoteSelecionados(l.lote)}
                          onChange={() => {
                            if (todoAmarradosDoLoteSelecionados(l.lote)) {
                              desmarcarTodosAmarradosDoLote(l.lote)
                            } else {
                              selecionarTodosAmarradosDoLote(l.lote)
                            }
                          }}
                        />
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <div className="font-semibold whitespace-nowrap">
                              Lote: {l.lote} ({l.amarrados?.length || 0} amarrados)
                            </div>
                            {l.amarrados && l.amarrados.length > 0 && (
                              <button
                                type="button"
                                className="text-xs text-blue-600 hover:text-blue-800 px-2 py-1 rounded border border-blue-200 hover:bg-blue-50"
                                onClick={() => toggleLoteExpandido(l.lote)}
                              >
                                {lotesExpandidos.includes(l.lote) ? 'Recolher' : 'Expandir'}
                              </button>
                            )}
                          </div>
                          <div className="text-gray-700 text-xs mt-1">
                            <div>Produto: {l.produto || '-'}</div>
                            <div>
                              Ferramenta: {l.ferramenta ? (
                                <>
                                  <span className="inline-block px-2 py-0.5 rounded bg-primary-50 text-primary-700 font-semibold">{l.ferramenta}</span>
                                  {l.comprimentoLongoMm ? (
                                    <span className="ml-2 text-gray-600">• Perfil Longo: {l.comprimentoLongoMm}</span>
                                  ) : null}
                                </>
                              ) : '-'}
                            </div>
                            {l.rack && (
                              <div>Rack: <span className="font-semibold text-blue-600">{l.rack}</span></div>
                            )}
                            <div>Romaneio: {l.romaneio || '-'}</div>
                            <div>Pedido: {l.pedido || '-'}</div>
                            <div>Seq: {l.seq || '-'}</div>
                          </div>
                          
                          {/* Lista de amarrados - só mostra se expandido */}
                          {l.amarrados && l.amarrados.length > 0 && lotesExpandidos.includes(l.lote) && (
                            <div className="mt-2 border-t pt-2">
                              <div className="text-xs font-medium text-gray-600 mb-1">Amarrados:</div>
                              <div className="space-y-1 max-h-32 overflow-y-auto">
                                {l.amarrados.map((amarrado, idx) => (
                                  <div key={`${amarrado.lote}-${amarrado.codigo}`} className="flex items-center gap-2 text-xs">
                                    <input
                                      type="checkbox"
                                      className="text-xs"
                                      checked={amarradosSelecionadosRack.some(a => a.codigo === amarrado.codigo && a.lote === amarrado.lote)}
                                      onChange={() => toggleAmarradoSelecionado(amarrado)}
                                    />
                                    <span className="font-mono text-blue-600">{amarrado.codigo}</span>
                                    <span className="text-gray-500">
                                      {amarrado.qt_kg > 0 && `${amarrado.qt_kg}kg`}
                                      {amarrado.qtd_pc > 0 && ` ${amarrado.qtd_pc}pcs`}
                                    </span>
                                    {amarrado.romaneio && (
                                      <span className="text-gray-400">Rom: {amarrado.romaneio}</span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn-outline" onClick={()=>{setRackModalAberto(false); setAmarradosSelecionadosRack([]); setLotesExpandidos([])}}>Cancelar</button>
              <button type="button" className="btn-primary" onClick={salvarRackELotes}>Salvar</button>
            </div>
          </div>
        </div>
      )}
      {/* Modal: Imprimir identificação? */}
      {imprimirAberto && (
        <div className="fixed inset-0 z-[68] flex items-center justify-center">
          <div className="absolute inset-0 bg-black bg-opacity-30" onClick={handleNaoImprimir}></div>
          <div className="relative bg-white rounded-lg shadow-lg w-full max-w-md p-5">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base font-semibold text-gray-800">Imprimir identificação do material?</h3>
              <button className="text-sm text-gray-600 hover:text-gray-900" onClick={handleNaoImprimir}>Fechar</button>
            </div>
            <div className="text-sm text-gray-700 space-y-3">
              <p>Apontamento registrado com sucesso.</p>
              <p><strong>Lote gerado:</strong> {ultimoLote}</p>

              {fotoUrlAtual && perguntarFotoMontagem && (
                <div className="border rounded-lg p-3 bg-green-50 space-y-3">
                  <div>
                    <div className="font-semibold text-gray-800">Visualizar foto para montagem do palete?</div>
                    <div className="text-xs text-gray-600">Você ainda poderá consultar a foto manualmente pelos ícones do apontamento.</div>
                  </div>
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <button
                      type="button"
                      className="btn-outline"
                      onClick={abrirFotoPadronizacaoManual}
                    >
                      Visualizar foto agora
                    </button>
                    <label className="flex items-center gap-2 text-xs text-gray-700">
                      <input
                        type="checkbox"
                        checked={perguntarFotoMontagem}
                        onChange={(e) => handleTogglePerguntarFotoMontagem(e.target.checked)}
                      />
                      Sempre perguntar sobre a foto nesta etapa
                    </label>
                  </div>
                </div>
              )}

              {fotoUrlAtual && !perguntarFotoMontagem && (
                <div className="border rounded-lg p-3 bg-gray-50 space-y-2">
                  <div className="text-xs text-gray-600">A pergunta da foto está desativada. Você pode continuar acessando a imagem manualmente nesta tela.</div>
                  <label className="flex items-center gap-2 text-xs text-gray-700">
                    <input
                      type="checkbox"
                      checked={perguntarFotoMontagem}
                      onChange={(e) => handleTogglePerguntarFotoMontagem(e.target.checked)}
                    />
                    Sempre perguntar sobre a foto nesta etapa
                  </label>
                </div>
              )}

              {/* Seleção do tipo de impressão */}
              <p>Escolha o tipo de impressão:</p>
              <div className="space-y-2">
                {(() => {
                  const configImpressoras = getConfiguracaoImpressoras()
                  return (
                    <>
                      <label className={`flex items-center gap-2 p-3 border rounded cursor-pointer hover:bg-gray-50 ${!configImpressoras.comum.ativa ? 'opacity-50' : ''}`}>
                        <input 
                          type="radio" 
                          name="tipoImpressao" 
                          value="documento" 
                          checked={tipoImpressao === 'documento'} 
                          onChange={(e) => setTipoImpressao(e.target.value)}
                          className="w-4 h-4"
                          disabled={!configImpressoras.comum.ativa}
                        />
                        <div className="flex-1">
                          <div className="font-semibold">🖨️ Formulário Completo (A4)</div>
                          <div className="text-xs text-gray-500">Documento A4 para identificação do rack</div>
                          <div className="text-xs text-blue-600 mt-1">
                            {configImpressoras.comum.ativa 
                              ? `📍 ${configImpressoras.comum.nome}` 
                              : '⚠️ Impressora não configurada'}
                          </div>
                        </div>
                      </label>
                      <label className={`flex items-center gap-2 p-3 border rounded cursor-pointer hover:bg-gray-50 ${!configImpressoras.termica.ativa ? 'opacity-50' : ''}`}>
                        <input 
                          type="radio" 
                          name="tipoImpressao" 
                          value="etiqueta" 
                          checked={tipoImpressao === 'etiqueta'} 
                          onChange={(e) => setTipoImpressao(e.target.value)}
                          className="w-4 h-4"
                          disabled={!configImpressoras.termica.ativa}
                        />
                        <div className="flex-1">
                          <div className="font-semibold">🏷️ Etiqueta Térmica (100x45mm)</div>
                          <div className="text-xs text-gray-500">Etiqueta compacta para impressora térmica</div>
                          <div className="text-xs text-blue-600 mt-1">
                            {configImpressoras.termica.ativa 
                              ? `📍 ${configImpressoras.termica.nome}` 
                              : '⚠️ Impressora não configurada'}
                          </div>
                        </div>
                      </label>
                    </>
                  )
                })()}
              </div>

              {/* Lote MP e distribuição (apenas para etiqueta térmica) */}
              {tipoImpressao === 'etiqueta' && (
                <div className="space-y-3 border-t pt-3 mt-3">
                  <div className="space-y-1">
                    <div className="font-semibold text-gray-800">Lote de Extrusão (MP)</div>
                    {lotesMPDisponiveis.length > 0 ? (
                      <select
                        className="w-full border rounded px-2 py-1"
                        value={loteMPSelecionado}
                        onChange={(e) => setLoteMPSelecionado(e.target.value)}
                      >
                        {lotesMPDisponiveis.map((lote) => (
                          <option key={lote} value={lote}>{lote}</option>
                        ))}
                      </select>
                    ) : (
                      <div className="text-xs text-gray-500">Nenhum lote MP disponível. Use o lote externo digitado.</div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold text-gray-800">Dividir etiquetas</div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="text-xs text-blue-600 hover:text-blue-800"
                          onClick={preencherAmostraDoAmarrado}
                        >
                          Copiar amostra do amarrado
                        </button>
                        <button
                          type="button"
                          className="text-xs text-blue-600 hover:text-blue-800"
                          onClick={addLinhaDistribuicao}
                        >
                          + Linha
                        </button>
                      </div>
                    </div>
                    <div className="space-y-1">
                      {etiquetasDistribuicao.map((row, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <input
                            type="number"
                            min="0"
                            step="1"
                            className="w-24 border rounded px-2 py-1 text-sm"
                            placeholder="Qtd/etq"
                            value={row.qtdPorEtiqueta}
                            onChange={(e) => atualizarDistribuicao(idx, 'qtdPorEtiqueta', e.target.value)}
                          />
                          <span className="text-xs text-gray-500">pcs</span>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            className="w-20 border rounded px-2 py-1 text-sm"
                            placeholder="Qtde"
                            value={row.qtdEtiquetas}
                            onChange={(e) => atualizarDistribuicao(idx, 'qtdEtiquetas', e.target.value)}
                          />
                          <span className="text-xs text-gray-500">etqs</span>
                          {etiquetasDistribuicao.length > 1 && (
                            <button
                              type="button"
                              className="text-xs text-red-600 hover:text-red-800 px-2 py-1"
                              onClick={() => removeLinhaDistribuicao(idx)}
                            >
                              Remover
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    {(() => {
                      const parseNum = (v) => Number(String(v || '').replace(',', '.')) || 0
                      const soma = etiquetasDistribuicao.reduce((acc, d) => acc + parseNum(d.qtdPorEtiqueta) * parseNum(d.qtdEtiquetas), 0)
                      const qtdTotal = Number(formData.quantidade || 0)
                      const ok = soma === qtdTotal && qtdTotal > 0
                      return (
                        <div className="text-xs">
                          <span className={`font-semibold ${ok ? 'text-green-700' : 'text-red-700'}`}>
                            Distribuição: {soma} pcs / {qtdTotal} pcs {ok ? '(OK)' : '(ajustar)'}
                          </span>
                        </div>
                      )
                    })()}
                  </div>
                </div>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn-outline" onClick={handleNaoImprimir}>Agora não</button>
              <button type="button" className="btn-primary" onClick={handleImprimirAgora}>Imprimir</button>
            </div>
          </div>
        </div>
      )}
      {/* Modal: Continuar no mesmo item? */}
      {continuarMesmoItemAberto && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center">
          <div className="absolute inset-0 bg-black bg-opacity-30" onClick={handleContinuarMesmoItem}></div>
          <div className="relative bg-white rounded-lg shadow-lg w-full max-w-md p-5">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base font-semibold text-gray-800">Continuar cortando o mesmo item?</h3>
              <button className="text-sm text-gray-600 hover:text-gray-900" onClick={handleContinuarMesmoItem}>Fechar</button>
            </div>
            <div className="text-sm text-gray-700 space-y-3">
              <p>Apontamento registrado com sucesso.</p>
              <p>Você deseja continuar cortando o <strong>mesmo item</strong>?</p>
              <ul className="list-disc ml-5 space-y-1">
                <li>Se escolher <strong>Continuar</strong>, manterei todos os campos e vou limpar apenas "Quantidade Produzida".</li>
                <li>Se escolher <strong>Novo item</strong>, vou limpar todos os campos para você selecionar o próximo pedido.</li>
              </ul>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn-outline" onClick={handleNovoItem}>Novo item</button>
              <button type="button" className="btn-primary" onClick={handleContinuarMesmoItem}>Continuar</button>
            </div>
          </div>
        </div>
      )}
        </div>

        
        {formData.ordemTrabalho === 'TESTE/01' && (
          <div className="mb-2 flex items-start gap-2 bg-amber-50 border border-amber-300 rounded-md px-3 py-2 text-amber-800 text-xs">
            <span className="text-amber-500 text-base mt-0.5">⚠️</span>
            <div>
              <span className="font-bold">Modo Teste / Sem Pedido</span> — Para registrar este apontamento, preencha obrigatoriamente:
              <ul className="mt-1 ml-3 list-disc space-y-0.5">
                <li><strong>Produto</strong> (informe o perfil ou material utilizado)</li>
                <li><strong>Observações</strong>: descreva o que foi feito e o comprimento cortado (ex.: "Teste TR-0011 – corte 1265mm")</li>
              </ul>
            </div>
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-3 form-compact">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            {/* Linha 1: Seleção principal */}
            <div className="md:col-span-3 lg:col-span-2">
              <label className="block label-sm font-medium text-gray-700 mb-1">
                Operador
              </label>
              <input
                type="text"
                name="operador"
                value={formData.operador}
                readOnly
                className="input-field input-field-sm bg-gray-100"
              />
            </div>
            
            <div className="md:col-span-3 lg:col-span-2">
              <label className="block label-sm font-medium text-gray-700 mb-1">
                Máquina
              </label>
              <select
                name="maquina"
                value={formData.maquina}
                onChange={handleChange}
                required
                className="input-field input-field-sm"
              >
                <option value="">Selecione a máquina</option>
                {(maquinas || []).map(maq => (
                  <option key={maq.id} value={maq.id}>{maq.nome || maq.codigo || `Máquina ${maq.id}`}</option>
                ))}
              </select>
            </div>

            <div className="md:col-span-6 lg:col-span-4">
              <div className="flex items-center justify-between mb-1">
                <label className="block label-sm font-medium text-gray-700">
                  Pedido/Seq
                </label>
                <button
                  type="button"
                  onClick={() => setFiltrarPrioridades(!filtrarPrioridades)}
                  className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded transition-colors ${
                    filtrarPrioridades 
                      ? 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200' 
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                  title={filtrarPrioridades ? 'Mostrando apenas prioritários' : 'Mostrar apenas prioritários'}
                >
                  <FaStar className={filtrarPrioridades ? 'text-yellow-500' : 'text-gray-400'} />
                  <span>{filtrarPrioridades ? 'Prioritários' : 'Todos'}</span>
                </button>
              </div>
              <div className="flex items-center gap-2">
                <select
                  name="ordemTrabalho"
                  value={formData.ordemTrabalho}
                  onChange={handleChange}
                  required
                  className={`input-field input-field-sm flex-1 ${formData.ordemTrabalho === 'TESTE/01' ? 'border-amber-400 bg-amber-50 text-amber-800 font-semibold' : ''}`}
                >
                  <option value="">{carregandoPedidos ? 'Carregando pedidos...' : 'Selecione o pedido'}</option>
                  <option value="TESTE/01">⚠️ TESTE/01 — Testes / Cortes sem Pedido (Uso Interno)</option>
                  {ordensTrabalho.map(ordem => (
                    <option key={ordem.id} value={ordem.id}>
                      {ordem.id} - {ordem.ferramenta} - {ordem.comprimentoAcabado || ''}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="p-2 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                  title="Buscar pedido"
                  onClick={() => setBuscaAberta(true)}
                  aria-label="Buscar pedido"
                >
                  <FaSearch />
                </button>
              </div>
            </div>
            
            <div className="md:col-span-6 lg:col-span-4">
              <div className="flex items-center justify-between">
                <label className="block label-sm font-medium text-gray-700 mb-1">
                  Produto
                </label>
                {ferramentaAtual ? (
                  <div className="flex items-center gap-2">
                    {/* Botão visualização 3D do palete */}
                    {ferramentaAtual && (() => {
                      const montagemUrl = `${window.location.origin}/montagem-palete?ferramenta=${encodeURIComponent(ferramentaAtual)}${comprimentoAtual ? `&comprimento=${comprimentoAtual}` : ''}`
                      return (
                        <a
                          href={montagemUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`Ver montagem 3D do palete — ${ferramentaAtual} (Abre em nova aba)`}
                          className="text-amber-600 hover:text-amber-800 transition-colors inline-flex cursor-pointer"
                        >
                          <FaCubes />
                        </a>
                      )
                    })()}
                    {(desenhoUrlAtual || pdfBasePath) ? (
                      <button
                        type="button"
                        onClick={abrirDesenhoManual}
                        title={`Abrir desenho: ${ferramentaAtual}.pdf`}
                        className="text-red-600 hover:text-red-800"
                      >
                        <FaFilePdf />
                      </button>
                    ) : (
                      <span title="Defina o caminho em Configurações > Arquivos" className="text-red-600 opacity-50">
                        <FaFilePdf />
                      </span>
                    )}
                    {/* Copiar caminho local */}
                    {pdfBasePath && (
                      <button type="button" title="Copiar caminho local" className="p-1 rounded border text-gray-600 hover:bg-gray-100"
                        onClick={() => {
                          const { base, file } = normalizePdfBaseAndFile(pdfBasePath, `${ferramentaAtual}.pdf`)
                          copyToClipboard(`${String(base).replace(/[\\/]+$/,'')}\\${file}`)
                        }}>
                        <FaCopy />
                      </button>
                    )}
                    
                    {(fichaUrlAtual || processBasePath) ? (
                      <button
                        type="button"
                        onClick={abrirFichaProcessoManual}
                        title={`Abrir ficha de processo: ${ferramentaAtual}.pdf`}
                        className="text-blue-600 hover:text-blue-800"
                      >
                        <FaFilePdf />
                      </button>
                    ) : (
                      <span title="Defina o caminho das fichas em Configurações > Arquivos" className="text-blue-600 opacity-50">
                        <FaFilePdf />
                      </span>
                    )}
                    {/* Copiar caminho local (processo) */}
                    {processBasePath && (
                      <button type="button" title="Copiar caminho local (processo)" className="p-1 rounded border text-gray-600 hover:bg-gray-100"
                        onClick={() => {
                          const { base, file } = normalizePdfBaseAndFile(processBasePath, `${ferramentaAtual}.pdf`)
                          copyToClipboard(`${String(base).replace(/[\\/]+$/,'')}\\${file}`)
                        }}>
                        <FaCopy />
                      </button>
                    )}

                    {fotoUrlAtual ? (
                      <button
                        type="button"
                        onClick={abrirFotoPadronizacaoManual}
                        title="Abrir foto de padronização"
                        className="text-green-600 hover:text-green-800"
                      >
                        <FaImage />
                      </button>
                    ) : (
                      <span title="Nenhuma foto de padronização cadastrada" className="text-green-600 opacity-50">
                        <FaImage />
                      </span>
                    )}
                    
                  </div>
                ) : (
                  <span
                    title="Selecione um pedido para habilitar"
                    className="text-red-600 opacity-50"
                  >
                    <FaFilePdf />
                  </span>
                )}
              </div>
              <input
                type="text"
                name="codigoPerfil"
                value={formData.codigoPerfil}
                readOnly={formData.ordemTrabalho !== 'TESTE/01'}
                onChange={formData.ordemTrabalho === 'TESTE/01' ? handleChange : undefined}
                placeholder={formData.ordemTrabalho === 'TESTE/01' ? 'Ex.: TR-0011, TP-0192...' : ''}
                className={`input-field input-field-sm ${formData.ordemTrabalho === 'TESTE/01' ? 'border-amber-400 bg-amber-50' : 'bg-gray-100'}`}
              />
              {/* Mensagem de ferramenta removida para reduzir ruído visual */}
            </div>

            {/* Linha 2: Dados de apoio do cliente e processo */}
            {modo === 'embalagem' && (
              <div className="md:col-span-3 lg:col-span-2">
                <label className="block label-sm font-medium text-gray-700 mb-1">Tipo de Processo</label>
                <select
                  name="processoEmbalagem"
                  value={formData.processoEmbalagem}
                  onChange={(e) => {
                    const v = e.target.value
                    setFormData(prev => ({
                      ...prev,
                      processoEmbalagem: v,
                      etapaEmbalagem: v === 'somente_embalagem' ? 'EMBALAGEM' : (prev.etapaEmbalagem || 'REBARBAR_LIMPEZA')
                    }))
                  }}
                  className="input-field input-field-sm"
                >
                  <option value="somente_embalagem">Somente Embalagem</option>
                  <option value="rebarbar_embalar">Rebarbar/Limpeza + Embalagem</option>
                </select>
              </div>
            )}

            <div className={`md:col-span-3 lg:col-span-${modo === 'embalagem' ? '2' : '3'}`}>
              <label className="block label-sm font-medium text-gray-700 mb-1">
                Cliente
              </label>
              <input
                type="text"
                name="cliente"
                value={formData.cliente}
                readOnly
                className="input-field input-field-sm bg-gray-100"
              />
            </div>

            <div className={`md:col-span-3 lg:col-span-${modo === 'embalagem' ? '2' : '3'}`}>
              <label className="block label-sm font-medium text-gray-700 mb-1">
                Pedido.Cliente
              </label>
              <input
                type="text"
                name="pedidoCliente"
                value={formData.pedidoCliente}
                readOnly
                className="input-field input-field-sm bg-gray-100"
              />
            </div>
            
            <div className="md:col-span-3 lg:col-span-3">
              <label className="block label-sm font-medium text-gray-700 mb-1">
                Código Cliente
              </label>
              <AutocompleteCodigoCliente
                codigoTecno={formData.codigoPerfil || ''}
                value={formData.codigoProdutoCliente}
                onChange={(value) => setFormData(prev => ({ ...prev, codigoProdutoCliente: value }))}
                placeholder="Digite ou busque o código do cliente..."
              />
            </div>
            
            <div className="md:col-span-3 lg:col-span-3">
              <label className="block label-sm font-medium text-gray-700 mb-1 whitespace-nowrap">
                Dt.Fatura (Entrega)
              </label>
              <input
                type="text"
                name="dtFatura"
                value={formData.dtFatura ? new Date(formData.dtFatura).toLocaleDateString('pt-BR') : ''}
                readOnly
                className="input-field input-field-sm bg-gray-100"
              />
            </div>
            
            {/* Linha 3: Controle de tempo e produção */}
            <div className="md:col-span-2 lg:col-span-2">
              <label className="block label-sm font-medium text-gray-700 mb-1">
                Início
              </label>
              <input
                type="datetime-local"
                name="inicio"
                value={formData.inicio}
                onChange={handleChange}
                required
                className="input-field input-field-sm"
              />
            </div>
            
            <div className="md:col-span-2 lg:col-span-2">
              <label className="block label-sm font-medium text-gray-700 mb-1">
                Fim
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="datetime-local"
                  name="fim"
                  value={formData.fim}
                  onChange={handleChange}
                  className="input-field input-field-sm flex-1 min-w-0"
                />
                {timerOn && (
                  <button 
                    type="button" 
                    className="btn-primary text-xs px-2 py-2 whitespace-nowrap flex-shrink-0" 
                    onClick={handleStopTimer} 
                    title="Finalizar contador"
                  >
                    Finalizar
                  </button>
                )}
              </div>
            </div>

            <div className="md:col-span-3 lg:col-span-3">
              <label className="block label-sm font-medium text-gray-700 mb-1">
                Quantidade Produzida
              </label>
              <input
                type="number"
                name="quantidade"
                value={formData.quantidade}
                onChange={handleChange}
                required
                min="1"
                className="input-field input-field-sm"
              />
            </div>
            
            <div className="md:col-span-1 lg:col-span-1">
              <label className="block label-sm font-medium text-gray-700 mb-1">
                Qtd.Pedido
              </label>
              <input
                type="text"
                name="qtdPedido"
                value={formData.qtdPedido}
                readOnly
                className="input-field input-field-sm bg-gray-100"
              />
            </div>

            <div className="md:col-span-1 lg:col-span-1">
              <label className="block label-sm font-medium text-gray-700 mb-1">
                Separado
              </label>
              <input
                type="text"
                name="separado"
                value={formData.separado}
                readOnly
                className="input-field input-field-sm bg-gray-100 h-[36px]"
              />
            </div>

            <div className="md:col-span-1 lg:col-span-1">
              <label className="block label-sm font-medium text-gray-700 mb-1">
                Unidade
              </label>
              <input
                type="text"
                name="unidade"
                value={formData.unidade}
                readOnly
                className="input-field input-field-sm bg-gray-100"
              />
            </div>

            <div className="md:col-span-2 lg:col-span-2">
              <label className="block label-sm font-medium text-gray-700 mb-1">
                Nº OP
              </label>
              <input
                type="text"
                name="nroOp"
                value={formData.nroOp}
                readOnly
                className="input-field input-field-sm bg-gray-100"
              />
            </div>
            
            {/* Linha 4: Perfil e ações */}
            <div className="md:col-span-4 lg:col-span-4">
              <label className="block label-sm font-medium text-gray-700 mb-1">
                Perfil Longo
              </label>
              <div className="space-y-2">
                <input
                  type="text"
                  name="perfilLongo"
                  value={formData.perfilLongo}
                  readOnly
                  className="input-field input-field-sm bg-gray-100"
                />
                <div>
                  <label className="block label-sm font-medium text-gray-700 mb-1 invisible">Ações</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn-primary flex-1 h-[36px] disabled:opacity-60 disabled:cursor-not-allowed"
                      onClick={() => { if (!formData.ordemTrabalho) { alert('Selecione um Pedido/Seq antes de abrir o contador.'); return } setShowTimerModal(true) }}
                      disabled={!formData.ordemTrabalho}
                      title={formData.ordemTrabalho ? 'Abrir contador em tela grande' : 'Selecione um Pedido/Seq para habilitar'}
                    >
                      Abrir Contador
                    </button>
                    <button
                      type="button"
                      className="btn-secondary flex items-center justify-center gap-2 h-[36px] px-4 disabled:opacity-60 disabled:cursor-not-allowed"
                      onClick={() => {
                        if (!formData.ordemTrabalho) { alert('Selecione um Pedido/Seq antes de informar romaneio/lote.'); return }
                        setTmpRomaneio(formData.romaneioNumero || '')
                        setTmpLotesExt((formData.lotesExternos && formData.lotesExternos.length) ? [...formData.lotesExternos] : [formData.loteExterno || ''])
                        setRomaneioAberto(true)
                      }}
                      disabled={!formData.ordemTrabalho}
                      title="Adicionar/editar Romaneio e Lotes"
                    >
                      <FaPlus />
                      <span>Romaneio/Lote</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
            

            {/* Painel de Produtividade (ocupa o restante da linha: md:col-span-8) */}
            <div className="md:col-span-8 lg:col-span-8">
              {estatisticasProduto ? (
                <div className="bg-gray-50 border border-gray-200 rounded-md p-2 h-full flex flex-col justify-center">
                  <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
                    <span className="font-semibold flex items-center gap-1"><FaChartLine className="text-blue-500" /> Resumo do Produto</span>
                    {estatisticasProduto.temHistorico && <span className="text-[10px]">Últimos {estatisticasProduto.historico.length} apont.</span>}
                  </div>
                  
                  <div className="flex items-stretch gap-2 w-full h-full">
                    {/* Coluna 1: Produtividade */}
                    <div className="flex flex-col justify-between min-w-0" style={{width:'18%'}}>
                      <div>
                        <div className="text-xl font-bold text-gray-800 leading-none whitespace-nowrap">
                          {estatisticasProduto.produtividadeMedia} <span className="text-[10px] font-normal text-gray-500">pcs/h</span>
                        </div>
                        <div className="text-[10px] text-gray-400 mb-1">Realizado</div>
                        {estatisticasProduto.comparativoStatus === 'acima' && (
                          <span className="inline-flex items-center rounded-full bg-green-100 text-green-700 px-2 py-0.5 text-[9px] font-semibold">
                            +{estatisticasProduto.diferencaTeorica} acima
                          </span>
                        )}
                        {estatisticasProduto.comparativoStatus === 'abaixo' && (
                          <span className="inline-flex items-center rounded-full bg-red-100 text-red-700 px-2 py-0.5 text-[9px] font-semibold">
                            -{estatisticasProduto.diferencaTeorica} abaixo
                          </span>
                        )}
                        {estatisticasProduto.comparativoStatus === 'igual' && (
                          <span className="inline-flex items-center rounded-full bg-blue-100 text-blue-700 px-2 py-0.5 text-[9px] font-semibold">Na meta</span>
                        )}
                        {estatisticasProduto.comparativoStatus === 'sem-meta' && (
                          <span className="inline-flex items-center rounded-full bg-gray-100 text-gray-500 px-2 py-0.5 text-[9px] font-semibold">Sem meta</span>
                        )}
                      </div>
                      <div className="mt-2 bg-orange-500 rounded-lg px-3 py-2 flex flex-col leading-tight">
                        <span className="text-[9px] font-bold text-orange-100 uppercase tracking-widest">Objetivo</span>
                        <span className="text-2xl font-black text-white leading-none">{estatisticasProduto.teoricoPcsHora}</span>
                        <span className="text-[9px] font-semibold text-orange-200">pcs/h</span>
                      </div>
                    </div>

                    {/* Coluna 2: pcs/Palete + Progresso paletes */}
                    <div className="flex gap-2 min-w-0" style={{width:'32%'}}>
                      {/* Card pcs/Palete */}
                      <div className="bg-orange-50 border-2 border-orange-300 rounded-lg px-3 py-2 flex flex-col justify-between flex-shrink-0 min-w-[90px]">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[10px] font-bold text-orange-600 uppercase tracking-wide">pcs/{estatisticasProduto.tipoEmbalagem}</span>
                          {isAdmin() && (
                            <button type="button" onClick={() => { setModalSenhaPcsPalete(true); setSenhaAdmin(''); setNovoPcsPalete(''); setNovoPcsAmarrado('') }}
                              className="text-orange-400 hover:text-orange-600 transition-colors" title="Editar pcs/Palete (Admin)">
                              <FaEdit className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        <span className="text-3xl font-extrabold text-orange-700 leading-tight">{estatisticasProduto.pcsPorPalete}</span>
                        {estatisticasProduto.kgPorPalete && (
                          <span className="text-[11px] font-bold text-orange-500 whitespace-nowrap">≈ {estatisticasProduto.kgPorPalete} kg</span>
                        )}
                        {estatisticasProduto.pcsPorAmarrado > 0 && estatisticasProduto.pcsPorPaleteNum > 0 && (() => {
                          const total = estatisticasProduto.pcsPorPaleteNum
                          const porAm = estatisticasProduto.pcsPorAmarrado
                          const amarradosInteiros = Math.floor(total / porAm)
                          const sobra = total % porAm
                          return (
                            <div className="mt-1 bg-orange-100 border border-orange-300 rounded-md px-2 py-0.5 flex items-center gap-1 justify-center">
                              <span className="text-[11px] font-extrabold text-orange-700">{amarradosInteiros}</span>
                              <span className="text-[9px] font-bold text-orange-500">amarr.</span>
                              {sobra > 0 && (
                                <span className="text-[9px] font-bold text-orange-400">+ {sobra} pç</span>
                              )}
                              <span className="text-[8px] text-orange-400">({porAm} pç/am)</span>
                            </div>
                          )
                        })()}
                      </div>
                      {/* Progresso paletes */}
                      {(() => {
                        const pcsP = estatisticasProduto.pcsPorPaleteNum
                        const qtdPed = Number(formData.qtdPedido || 0)
                        const totalAp = Number(totalApontado || 0)
                        if (!pcsP || !qtdPed) return null
                        const paletesTotais = Math.ceil(qtdPed / pcsP)
                        const paleteFeitos = Math.floor(totalAp / pcsP)
                        const percentual = qtdPed > 0 ? Math.min(100, Math.round((totalAp / qtdPed) * 100)) : 0
                        // Peso total dos paletes feitos
                        const kgPalete = estatisticasProduto.kgPorPalete
                          ? Number(String(estatisticasProduto.kgPorPalete).replace(/\./g, '').replace(',', '.'))
                          : 0
                        const kgTotal = kgPalete > 0 ? paleteFeitos * kgPalete : 0
                        const kgTotalFmt = kgTotal > 0
                          ? kgTotal.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
                          : null
                        return (
                          <div className="flex-1 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 flex flex-col justify-between min-w-0">
                            <div className="flex justify-between items-center">
                              <span className="text-[9px] font-semibold text-gray-500 uppercase tracking-wide">Paletes</span>
                              <span className={`text-[9px] font-extrabold ${percentual >= 100 ? 'text-green-600' : percentual >= 70 ? 'text-blue-600' : 'text-orange-500'}`}>{percentual}%</span>
                            </div>
                            <div className="flex items-baseline gap-1">
                              <span className="text-lg font-extrabold text-gray-800">{paleteFeitos}</span>
                              <span className="text-[10px] text-gray-400 font-medium">/ {paletesTotais}</span>
                            </div>
                            {kgTotalFmt && (
                              <div className="text-[10px] font-bold text-gray-600 whitespace-nowrap">
                                ≈ <span className="text-gray-800">{kgTotalFmt} kg</span> produzidos
                              </div>
                            )}
                            <div className="w-full bg-gray-200 rounded-full h-1.5">
                              <div className={`h-1.5 rounded-full transition-all ${percentual >= 100 ? 'bg-green-500' : percentual >= 70 ? 'bg-blue-500' : 'bg-orange-400'}`}
                                style={{ width: `${percentual}%` }} />
                            </div>
                          </div>
                        )
                      })()}
                    </div>

                    {/* Coluna 3: Qualidade NBR */}
                    <div className="shrink-0 border-l border-indigo-200 bg-indigo-50 rounded px-2 py-1.5 flex flex-col justify-between" style={{width:'18%'}}>
                      <div className="text-[9px] font-bold text-indigo-600 uppercase tracking-wider">Qualidade NBR 5426 S3</div>
                      {(() => {
                        const pcsPorPalete = Number(String(estatisticasProduto.pcsPorPalete || '0').replace(/\D/g, '')) || 0
                        const tamanhoLote = pcsPorPalete > 0 ? pcsPorPalete : 1
                        const amostraNBR = getTamanhAmostraNBRS3(tamanhoLote)
                        return (
                          <>
                            <div>
                              <div className="text-2xl font-bold text-indigo-700 leading-none">{amostraNBR}</div>
                              <div className="text-[9px] text-indigo-600 font-medium">pcs/palete a inspecionar</div>
                            </div>
                            <div className="text-[9px] text-indigo-500 bg-white rounded p-1 mt-1">
                              Lote: {tamanhoLote} | Amostra: {amostraNBR} ({((amostraNBR/tamanhoLote)*100).toFixed(1)}%)
                            </div>
                          </>
                        )
                      })()}
                    </div>

                    {estatisticasProduto.temHistorico && (
                      <div className="flex-1 relative min-w-0 pr-2" style={{minHeight:'72px'}}>
                        <Line
                          options={{
                            responsive: true,
                            maintainAspectRatio: false,
                            plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 10, usePointStyle: true } }, tooltip: { enabled: true } },
                            scales: { x: { display: false }, y: { display: false } },
                            layout: { padding: 0 }
                          }}
                          data={{
                            labels: estatisticasProduto.historico.map(h => h.data),
                            datasets: [
                              {
                                label: 'Realizado',
                                data: estatisticasProduto.historico.map(h => h.pcsH),
                                borderColor: '#3b82f6',
                                backgroundColor: '#3b82f6',
                                borderWidth: 3,
                                pointRadius: 3,
                                pointBackgroundColor: '#3b82f6',
                                tension: 0.3
                              },
                              {
                                label: 'Objetivo',
                                data: estatisticasProduto.historico.map(() => estatisticasProduto.teoricoPcsHoraValor || 0),
                                borderColor: '#f97316',
                                backgroundColor: '#f97316',
                                borderWidth: 2,
                                pointRadius: 0,
                                borderDash: [6, 4],
                                tension: 0
                              }
                            ]
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="bg-gray-50 border border-gray-100 rounded-md p-2 h-full flex items-center justify-center text-xs text-gray-400">
                  Selecione um produto para ver estatísticas
                </div>
              )}
            </div>
          </div>
          
          <div className="w-full">
            <label className="block label-sm font-medium text-gray-700 mb-1">
              Observações
              {formData.ordemTrabalho === 'TESTE/01' && (
                <span className="ml-1 text-amber-600 font-bold text-[10px]">* obrigatório para Teste/Sem Pedido</span>
              )}
            </label>
            <textarea
              name="observacoes"
              value={formData.observacoes}
              onChange={handleChange}
              className={`input-field input-field-sm ${formData.ordemTrabalho === 'TESTE/01' && !formData.observacoes ? 'border-amber-400 bg-amber-50' : ''}`}
              placeholder={formData.ordemTrabalho === 'TESTE/01' ? 'Descreva o trabalho e informe o comprimento cortado. Ex.: "Teste TR-0011 – corte 1265mm"' : ''}
            />
          </div>

          {/* Painel de Ritmo do Turno */}
          <div className="w-full mt-2">
            <PainelRitmoTurno
              apontamentos={apontamentosDB || []}
              metaDiaria={metaDiariaRitmo}
              turnos={turnosRitmo}
              teoricoPcsHora={estatisticasProduto?.teoricoPcsHora || 0}
            />
          </div>

          {/* Seção de Amarrados/Lotes Selecionados */}
          {((formData.lotesExternos && formData.lotesExternos.length > 0) || (formData.amarradosDetalhados && formData.amarradosDetalhados.length > 0)) && (
            <div className="col-span-full">
              <div className="flex items-center justify-between mb-2">
                <label className="block label-sm font-medium text-gray-700">
                  {formData.amarradosDetalhados && formData.amarradosDetalhados.length > 0 
                    ? `Amarrados Selecionados (${formData.amarradosDetalhados.length})`
                    : `Lotes Selecionados (${formData.lotesExternos?.length || 0})`
                  }
                </label>
                <div className="flex items-center gap-2">
                  {formData.rack_ou_pallet && (
                    <span className="text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded">
                      Rack: {formData.rack_ou_pallet}
                    </span>
                  )}
                  <button
                    type="button"
                    className="text-xs text-red-600 hover:text-red-800"
                    onClick={() => {
                      if (window.confirm('Deseja remover todos os amarrados/lotes selecionados?')) {
                        setFormData(prev => ({
                          ...prev,
                          lotesExternos: [],
                          loteExterno: '',
                          rack_ou_pallet: '',
                          rackOuPallet: '',
                          amarradosDetalhados: []
                        }))
                      }
                    }}
                    title="Remover todos os amarrados/lotes"
                  >
                    Limpar todos
                  </button>
                </div>
              </div>
              <div className="border rounded p-3 bg-gray-50 max-h-32 overflow-auto">
                <div className="flex flex-wrap gap-2">
                  {/* Mostra amarrados detalhados se existirem */}
                  {formData.amarradosDetalhados && formData.amarradosDetalhados.length > 0 ? (
                    formData.amarradosDetalhados.map((amarrado, idx) => (
                      <div key={idx} className="flex items-center gap-1 bg-white border rounded px-2 py-1 text-sm">
                        <span className="font-mono text-blue-600">{amarrado.codigo}</span>
                        <span className="text-xs text-gray-500">({amarrado.lote})</span>
                        {amarrado.qt_kg > 0 && (
                          <span className="text-xs text-gray-400">{amarrado.qt_kg}kg</span>
                        )}
                        <button
                          type="button"
                          className="text-red-500 hover:text-red-700 ml-1"
                          onClick={() => {
                            setFormData(prev => ({
                              ...prev,
                              amarradosDetalhados: prev.amarradosDetalhados.filter((_, i) => i !== idx)
                            }))
                          }}
                          title="Remover este amarrado"
                        >
                          ×
                        </button>
                      </div>
                    ))
                  ) : (
                    /* Fallback para lotes simples */
                    formData.lotesExternos?.map((lote, idx) => (
                      <div key={idx} className="flex items-center gap-1 bg-white border rounded px-2 py-1 text-sm">
                        <span className="font-mono">{lote}</span>
                        <button
                          type="button"
                          className="text-red-500 hover:text-red-700 ml-1"
                          onClick={() => {
                            setFormData(prev => ({
                              ...prev,
                              lotesExternos: prev.lotesExternos.filter((_, i) => i !== idx),
                              loteExterno: prev.lotesExternos.length === 1 ? '' : prev.loteExterno
                            }))
                          }}
                          title="Remover este lote"
                        >
                          ×
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-end pt-2 gap-2">
            <button
              type="button"
              className="btn-outline flex items-center gap-2"
              onClick={() => { if (confirm('Deseja realmente limpar o formulário?')) clearForm() }}
              title="Limpar todos os campos e começar do zero"
            >
              <FaBroom />
              <span>Limpar</span>
            </button>
            <button 
              type="submit" 
              className="btn-primary"
              disabled={somenteVisualizacao}
              title={somenteVisualizacao ? 'Você não tem permissão para registrar apontamentos' : ''}
            >
              Registrar Apontamento
            </button>
            {somenteVisualizacao && (
              <span className="ml-3 text-sm text-gray-500 italic">Modo visualização</span>
            )}
          </div>
        </form>
      </div>

      {/* Modal de confirmação do apontamento */}
      {confirmarAberto && (
        <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
          <div className="relative bg-white rounded-lg shadow-lg w-full max-w-md p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-semibold text-gray-800">Confirmar Apontamento</h3>
              <button className="text-sm text-gray-600 hover:text-gray-900" onClick={() => setConfirmarAberto(false)}>Fechar</button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700 mb-1">Quantidade Produzida</label>
                <input type="number" className="input-field input-field-sm bg-gray-100" value={formData.quantidade} readOnly />
              </div>
              <div>
                <label className="block text-sm text-gray-700 mb-1">Confirmar Quantidade</label>
                <input type="number" className="input-field input-field-sm" value={qtdConfirmada} onChange={(e)=>setQtdConfirmada(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-sm text-gray-700 mb-1">Refugos/Sucata (PCs)</label>
                  <input type="number" className="input-field input-field-sm" placeholder="0" value={qtdRefugo} onChange={(e)=>setQtdRefugo(e.target.value)} />
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-1">Compr (mm)</label>
                  <input type="number" className="input-field input-field-sm" placeholder="0" value={comprimentoRefugo} onChange={(e)=>setComprimentoRefugo(e.target.value)} />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-semibold text-blue-800">Rack/Pallet (Acabado) *</label>
                  <button
                    type="button"
                    onClick={() => setEditandoRack(prev => !prev)}
                    title={editandoRack ? 'Bloquear edição' : 'Editar número do rack manualmente'}
                    className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded border transition-colors ${
                      editandoRack
                        ? 'bg-yellow-100 border-yellow-400 text-yellow-700 hover:bg-yellow-200'
                        : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-100 hover:text-blue-600'
                    }`}
                  >
                    <FaEdit className="w-3 h-3" />
                    {editandoRack ? 'Bloqueando' : 'Editar'}
                  </button>
                </div>
                <input 
                  type="text" 
                  className={`input-field input-field-sm focus:ring-blue-500 transition-colors ${
                    editandoRack
                      ? 'border-yellow-400 bg-yellow-50'
                      : 'border-blue-300 bg-blue-50'
                  }`}
                  placeholder="Será gerado automaticamente" 
                  value={formData.rack_acabado} 
                  onChange={(e) => setFormData(prev => ({ ...prev, rack_acabado: e.target.value }))} 
                  readOnly={!editandoRack}
                />
                {editandoRack && (
                  <p className="text-xs text-yellow-700 mt-1">⚠ Edição manual ativa — certifique-se de usar um rack válido.</p>
                )}
                <div className="mt-3 border border-blue-200 bg-blue-50 rounded-md p-2 flex items-start gap-2 shadow-inner">
                  <input
                    type="checkbox"
                    id="finalizarRack"
                    checked={finalizarRack}
                    onChange={(e) => setFinalizarRack(e.target.checked)}
                    className="mt-0.5 w-4 h-4 text-blue-600 border-blue-400 rounded focus:ring-blue-500"
                  />
                  <label htmlFor="finalizarRack" className="text-sm text-blue-900 font-semibold cursor-pointer leading-snug">
                    Finalizar rack agora e gerar um novo na próxima produção
                    <span className="block text-xs font-normal text-blue-700">Desmarque apenas se o rack continuará no próximo turno.</span>
                  </label>
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-700 mb-1">Dureza do Material</label>
                <input type="text" className="input-field input-field-sm" placeholder="Ex.: HRC 45-50" value={durezaMaterial} onChange={(e)=>setDurezaMaterial(e.target.value)} />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn-outline" onClick={()=>setConfirmarAberto(false)}>Cancelar</button>
              <button 
                type="button" 
                className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded text-sm font-semibold transition"
                onClick={() => {
                  const pcsPorPalete = Number(String(estatisticasProduto?.pcsPorPalete || '0').replace(/\D/g, '')) || 0
                  const tamanhoLote = pcsPorPalete > 0 ? pcsPorPalete : 1
                  const amostraPorPalete = getTamanhAmostraNBRS3(tamanhoLote)
                  const pcsPorBloco = 80

                  setApontamentoParaInspecao({
                    id: `temp-${Date.now()}`,
                    quantidade: qtdConfirmada || formData.quantidade,
                    produto: formData.codigoPerfil,
                    codigoPerfil: formData.codigoPerfil,
                    pedido_seq: formData.ordemTrabalho,
                    ordem_trabalho: formData.ordemTrabalho,
                    rack_acabado: formData.rack_acabado,
                    rackAcabado: formData.rack_acabado,
                    inicio: formData.inicio,
                    fim: formData.fim,
                    pcs_por_palete: pcsPorPalete,
                    amostra_por_palete: amostraPorPalete,
                    pcs_por_bloco: pcsPorBloco
                  })
                  setInspecaoAberta(true)
                }}
              >
                Inspeção QA
              </button>
              <button type="button" className="btn-primary" onClick={concluirRegistro}>Confirmar</button>
            </div>
          </div>
        </div>
      )}
      {/* Modal: Listar apontamentos da ordem atual */}
      {listarApontAberto && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black bg-opacity-30" onClick={() => setListarApontAberto(false)}></div>
          <div className="relative bg-white rounded-lg shadow-lg w-full max-w-4xl p-4 form-compact">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-semibold text-gray-800">Apontamentos do Pedido {formData.ordemTrabalho}</h3>
              <button className="text-sm text-gray-600 hover:text-gray-900" onClick={() => setListarApontAberto(false)}>Fechar</button>
            </div>
            <div className="max-h-96 overflow-auto border rounded">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-3 py-2">Início</th>
                    <th className="text-left px-3 py-2">Fim</th>
                    {modo === 'embalagem' && <th className="text-left px-3 py-2">Etapa</th>}
                    <th className="text-left px-3 py-2">Quantidade</th>
                    <th className="text-left px-3 py-2">Comprimento</th>
                    <th className="text-left px-3 py-2">Comp. Longo</th>
                    <th className="text-left px-3 py-2">Operador</th>
                    <th className="text-left px-3 py-2">Rack/Pallet</th>
                    <th className="text-left px-3 py-2">Obs.</th>
                    {isAdmin() && <th className="text-center px-3 py-2">Ações</th>}
                  </tr>
                </thead>
                <tbody>
                  {apontamentosDaOrdem.map((a, idx) => (
                    <tr key={idx} className="border-t hover:bg-gray-50">
                      <td className="px-3 py-2">{a.inicio ? new Date(a.inicio).toLocaleString('pt-BR') : ''}</td>
                      <td className="px-3 py-2">{a.fim ? new Date(a.fim).toLocaleString('pt-BR') : ''}</td>
                      {modo === 'embalagem' && (
                        <td className="px-3 py-2">
                          {String(a.etapa_embalagem || '').trim() ? String(a.etapa_embalagem).replace(/_/g, '/').toLowerCase() : 'embalagem'}
                        </td>
                      )}
                      <td className="px-3 py-2">{a.quantidade}</td>
                      <td className="px-3 py-2">{a.comprimento_acabado_mm ? `${a.comprimento_acabado_mm}mm` : '-'}</td>
                      <td className="px-3 py-2">{extrairComprimentoPerfilLongo(a.perfil_longo || '')}</td>
                      <td className="px-3 py-2">{a.operador || ''}</td>
                      <td className="px-3 py-2">{a.rackOuPallet || ''}</td>
                      <td className="px-3 py-2">{a.observacoes || ''}</td>
                      {isAdmin() && (
                        <td className="px-3 py-2 text-center">
                          <button
                            onClick={() => setApontamentoParaCorrigir(a)}
                            className="text-blue-600 hover:text-blue-800 hover:underline text-xs font-medium"
                            title="Corrigir apontamento"
                          >
                            <FaWrench className="inline mr-1" />
                            Corrigir
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {apontamentosDaOrdem.length === 0 && (
                    <tr>
                      <td colSpan={String((isAdmin() ? 7 : 6) + (modo === 'embalagem' ? 1 : 0))} className="px-3 py-6 text-center text-gray-500">Nenhum apontamento encontrado para este pedido</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {/* Modal: Contador grande */}
      {showTimerModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black bg-opacity-50" onClick={() => setShowTimerModal(false)}></div>
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-3xl p-6">
            <div className="flex items-start justify-between mb-4">
              <h3 className="text-xl font-bold text-gray-800">Contador de Produção</h3>
              <button className="text-sm text-gray-600 hover:text-gray-900" onClick={() => setShowTimerModal(false)}>Fechar</button>
            </div>
            <div className="flex flex-col items-center gap-4">
              <div className="text-7xl font-mono font-extrabold tracking-widest text-gray-900">
                {formatHMS((timerOn ? nowTick : Date.now()) - (timerStart ? timerStart.getTime() : Date.now()))}
              </div>
              <div className="text-gray-600 text-sm">
                {timerStart ? `Iniciado em ${timerStart.toLocaleString('pt-BR')}` : 'Aguardando início'}
              </div>
              <div className="flex items-center gap-3 mt-2">
                {!timerOn ? (
                  <button type="button" className="btn-primary text-lg px-6 py-3" onClick={handleStartTimer}>
                    Iniciar
                  </button>
                ) : (
                  <button type="button" className="btn-danger text-lg px-6 py-3" onClick={handleStopTimer}>
                    Finalizar contador
                  </button>
                )}
                {timerOn && (
                  <button type="button" className="btn-outline text-lg px-6 py-3" onClick={() => setShowTimerModal(false)}>
                    Minimizar (contador continua rodando)
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {buscaAberta && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black bg-opacity-30" onClick={() => setBuscaAberta(false)}></div>
          <div className="relative bg-white rounded-lg shadow-lg w-full max-w-7xl p-4 form-compact mx-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-semibold text-gray-800">Buscar Pedido</h3>
              <button className="text-sm text-gray-600 hover:text-gray-900" onClick={() => setBuscaAberta(false)}>Fechar</button>
            </div>
            <div className="mb-3">
              <input
                type="text"
                placeholder="Digite Pedido/Seq, Ferramenta (ex.: TP-0192, EXP-910) ou Comprimento (ex.: 1100)"
                className="input-field input-field-sm"
                value={buscaTexto}
                onChange={(e) => setBuscaTexto(e.target.value)}
                autoFocus
              />
            </div>
            <div className="max-h-80 overflow-auto border rounded">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-3 py-2">Pedido/Seq</th>
                    <th className="text-left px-3 py-2">Ferramenta</th>
                    <th className="text-left px-3 py-2">Produto</th>
                    <th className="text-left px-3 py-2">Comprimento</th>
                    <th className="text-left px-3 py-2">Comp. Longo</th>
                    <th className="text-left px-3 py-2">Cliente</th>
                    <th className="text-left px-3 py-2">Pedido.Cliente</th>
                    <th className="text-left px-3 py-2">Data Entrega</th>
                    <th className="text-right px-3 py-2">Qtd. Pedido</th>
                    <th className="text-right px-3 py-2">Faturado</th>
                    <th className="text-right px-3 py-2">Saldo</th>
                    <th className="text-left px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {ordensFiltradas.map((o) => (
                    <tr key={o.id} className={`border-t ${o._generico ? 'bg-amber-50 hover:bg-amber-100' : 'hover:bg-gray-50'}`}>
                      <td className="px-3 py-2 font-semibold">
                        {o._generico ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="bg-amber-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide">TESTE</span>
                            <span className="text-amber-700">{o.id}</span>
                          </span>
                        ) : o.id}
                      </td>
                      <td className="px-3 py-2">{o.ferramenta}</td>
                      <td className="px-3 py-2">
                        {o._generico ? <span className="text-amber-700 font-medium italic">{o.descricao}</span> : o.codigoPerfil}
                      </td>
                      <td className="px-3 py-2">{o._generico ? '-' : Number(o.comprimentoAcabado || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}</td>
                      <td className="px-3 py-2">{o._generico ? '-' : extrairComprimentoPerfilLongo(o.perfilLongo || '')}</td>
                      <td className="px-3 py-2">{o.cliente}</td>
                      <td className="px-3 py-2">{o.pedidoCliente}</td>
                      <td className="px-3 py-2">{o.dtFatura ? new Date(o.dtFatura).toLocaleDateString('pt-BR') : '-'}</td>
                      <td className="px-3 py-2 text-right font-semibold">
                        {o._generico ? (
                          <span className="text-gray-400 text-xs italic">-</span>
                        ) : (
                          <span className="text-gray-700">
                            {Number(o.qtdPedido || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold">
                        {o._generico ? (
                          <span className="text-gray-400 text-xs italic">-</span>
                        ) : (
                          <span className="text-gray-700">
                            {Number(o.separado || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold">
                        {o._generico ? (
                          <span className="text-gray-400 text-xs italic">livre</span>
                        ) : (() => {
                          const apontadoParaEsteItem = totalApontadoPorPedido[String(o.id)] || 0
                          const saldoItem = Number(o.qtdPedido || 0) - apontadoParaEsteItem
                          return (
                            <span className={saldoItem <= 0 ? 'text-green-600' : 'text-orange-600'}>
                              {saldoItem.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}
                            </span>
                          )
                        })()}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          className="btn-secondary py-1 px-2"
                          onClick={() => {
                            // Seleciona e preenche o formulário
                            setFormData(prev => ({
                              ...prev,
                              ordemTrabalho: o.id,
                              codigoPerfil: o.codigoPerfil,
                              qtdPedido: o.qtdPedido,
                              perfilLongo: o.perfilLongo,
                              separado: o.separado,
                              cliente: o.cliente,
                              pedidoCliente: o.pedidoCliente,
                              dtFatura: o.dtFatura,
                              unidade: o.unidade,
                              comprimentoAcabado: o.comprimentoAcabado,
                              nroOp: o.nroOp,
                              // Preenche início automaticamente se vazio
                              inicio: (prev.inicio || getNowLocalInput()),
                              // Define fim automaticamente como 1h após o início se ainda vazio
                              fim: prev.fim || addMinutesToInput((prev.inicio || getNowLocalInput()), 60)
                            }))
                            setBuscaAberta(false)
                            setPedidoSeqSelecionado(o.id)
                            setRackDigitado('')
                            setLotesEncontrados([])
                            setLotesSelecionados([])
                            // Para TESTE/01 o rack não é obrigatório — não abre modal
                            if (!o._generico) setRackModalAberto(true)
                          }}
                        >
                          Selecionar
                        </button>
                      </td>
                    </tr>)
                  )}
                  {ordensFiltradas.length === 0 && (
                    <tr>
                      <td colSpan="7" className="px-3 py-6 text-center text-gray-500">Nenhum pedido encontrado</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      
      {/* Modal: Correção de Apontamento */}
      {apontamentoParaCorrigir && (
        <CorrecaoApontamentoModal
          apontamento={apontamentoParaCorrigir}
          usuarioId={user?.id}
          onClose={() => setApontamentoParaCorrigir(null)}
          onSucesso={() => {
            recarregarApontamentos()
            setApontamentoParaCorrigir(null)
          }}
        />
      )}

      {/* Modal: Buscar Rack/Embalagem por Código do Produto */}
      {buscarRackProdutoAberto && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center">
          <div className="absolute inset-0 bg-black bg-opacity-40" onClick={() => setBuscarRackProdutoAberto(false)}></div>
          <div className="relative bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[85vh] flex flex-col mx-4">
            <div className="px-6 py-4 border-b flex items-center justify-between bg-orange-50">
              <h3 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                <FaBox className="text-orange-500" />
                Buscar Rack!Embalagem por Produto
              </h3>
              <button 
                className="text-gray-500 hover:text-gray-700 text-xl" 
                onClick={() => setBuscarRackProdutoAberto(false)}
              >
                &times;
              </button>
            </div>
            
            {/* Campos de filtro */}
            <div className="px-6 py-4 border-b bg-gray-50 space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Código do Produto</label>
                <input
                  type="text"
                  className="w-full border rounded-lg px-4 py-2 text-sm focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  placeholder="Ex: TG2012565508NANV"
                  value={codigoProdutoBusca}
                  onChange={(e) => setCodigoProdutoBusca(e.target.value.toUpperCase())}
                  autoFocus
                />
              </div>
              
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Ferramenta</label>
                  <input
                    type="text"
                    className="w-full border rounded-lg px-4 py-2 text-sm focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                    placeholder="Ex: TR, TG, TP"
                    value={filtroFerramentaBusca}
                    onChange={(e) => setFiltroFerramentaBusca(e.target.value.toUpperCase())}
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Comprimento</label>
                  <input
                    type="text"
                    className="w-full border rounded-lg px-4 py-2 text-sm focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                    placeholder="Ex: 100, 200, 500"
                    value={filtroComprimentoBusca}
                    onChange={(e) => setFiltroComprimentoBusca(e.target.value.toUpperCase())}
                  />
                </div>
              </div>
              
              <p className="text-xs text-gray-500">
                {resultadosRackProduto.length === 0 ? (
                  codigoProdutoBusca.length >= 2 || filtroFerramentaBusca.length >= 2 || filtroComprimentoBusca.length >= 1
                    ? 'Nenhum resultado encontrado'
                    : 'Preencha pelo menos um filtro'
                ) : (
                  `${resultadosRackProduto.length} rack(s) encontrado(s)`
                )}
              </p>
            </div>
            
            {/* Resultados */}
            <div className="flex-1 overflow-auto px-6 py-4">
              {resultadosRackProduto.length > 0 ? (
                <div className="space-y-4">
                  <div className="text-sm text-gray-600 mb-2">
                    Encontrado(s) <strong>{resultadosRackProduto.length}</strong> Rack(s)
                    {codigoProdutoBusca && ` - Produto: ${codigoProdutoBusca}`}
                    {filtroFerramentaBusca && ` - Ferramenta: ${filtroFerramentaBusca}`}
                    {filtroComprimentoBusca && ` - Comprimento: ${filtroComprimentoBusca}`}
                  </div>
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="text-left px-4 py-3 font-semibold text-gray-700">Rack!Embalagem</th>
                        <th className="text-center px-4 py-3 font-semibold text-gray-700">Qtd Amarrados</th>
                        <th className="text-right px-4 py-3 font-semibold text-gray-700">Qt Kg</th>
                        <th className="text-right px-4 py-3 font-semibold text-gray-700">Qtd PC</th>
                        <th className="text-left px-4 py-3 font-semibold text-gray-700">Romaneio(s)</th>
                        <th className="text-left px-4 py-3 font-semibold text-gray-700">Produto(s)</th>
                        <th className="text-left px-4 py-3 font-semibold text-gray-700">Pedido(s)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {resultadosRackProduto.map((r, idx) => (
                        <tr key={idx} className="border-t hover:bg-orange-50">
                          <td className="px-4 py-3">
                            <span className="px-3 py-1 rounded bg-orange-100 text-orange-800 font-bold text-base">
                              {r.rack}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className="px-3 py-1 rounded bg-blue-100 text-blue-800 font-semibold">
                              {r.qtdAmarrados}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-gray-700">
                            {Number(r.totalKg || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-gray-700">
                            {Number(r.totalPc || 0).toLocaleString('pt-BR')}
                          </td>
                          <td className="px-4 py-3 text-gray-700">{r.romaneios}</td>
                          <td className="px-4 py-3 text-gray-600 text-xs max-w-[200px] truncate" title={r.produtos}>{r.produtos}</td>
                          <td className="px-4 py-3 text-gray-600 text-xs max-w-[150px] truncate" title={r.pedidos}>{r.pedidos}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : codigoProdutoBusca.length >= 2 ? (
                <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                  <FaBox className="text-5xl text-gray-300 mb-4" />
                  <p className="text-lg">Nenhum Rack encontrado para "{codigoProdutoBusca}"</p>
                  <p className="text-sm mt-1">Verifique se o código está correto ou tente outro termo</p>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-gray-400">
                  <FaSearch className="text-5xl text-gray-200 mb-4" />
                  <p className="text-lg">Digite o código do produto para buscar</p>
                  <p className="text-sm mt-1">Ex: TG2012565508NANV, TP8329, TG201</p>
                </div>
              )}
            </div>
            
            {/* Rodapé */}
            <div className="px-6 py-3 border-t bg-gray-50 flex justify-end">
              <button
                type="button"
                className="px-4 py-2 rounded border border-gray-300 text-gray-700 hover:bg-gray-100"
                onClick={() => setBuscarRackProdutoAberto(false)}
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Modal de Pré-visualização da Etiqueta */}
      {etiquetaPreviewAberta && apontamentoPreview && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black bg-opacity-80 backdrop-blur-sm" onClick={() => setEtiquetaPreviewAberta(false)}></div>
          <div className="relative bg-white rounded-2xl shadow-2xl max-w-3xl w-full mx-4 overflow-hidden flex flex-col max-h-[95vh]">
            {/* Header com gradiente */}
            <div className="relative bg-gradient-to-r from-green-600 to-green-700 p-6 text-white flex-none">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 bg-white/20 rounded-xl flex items-center justify-center backdrop-blur-sm">
                    <FaEye className="text-2xl" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold">Pré-visualização da Etiqueta</h3>
                    <p className="text-green-100 text-sm mt-1">
                      Pedido: {apontamentoPreview.ordem_trabalho || apontamentoPreview.ordemTrabalho || 'N/A'}
                    </p>
                  </div>
                </div>
                <button
                  className="w-10 h-10 bg-white/20 rounded-lg flex items-center justify-center hover:bg-white/30 transition-all backdrop-blur-sm"
                  onClick={() => setEtiquetaPreviewAberta(false)}
                >
                  <FaTimes className="text-lg" />
                </button>
              </div>
            </div>
            
            {/* Abas de seleção de tipo de etiqueta */}
            <div className="flex border-b border-gray-200 bg-gray-50 flex-none px-6">
              <button
                className={`py-3 px-6 font-medium text-sm transition-colors border-b-2 flex items-center gap-2 ${
                  tipoPreview === 'etiquetas' 
                    ? 'border-green-600 text-green-700 bg-white' 
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                }`}
                onClick={() => setTipoPreview('etiquetas')}
              >
                <FaBarcode /> Etiqueta Térmica (100x45mm)
              </button>
              <button
                className={`py-3 px-6 font-medium text-sm transition-colors border-b-2 flex items-center gap-2 ${
                  tipoPreview === 'etiqueta_palete' 
                    ? 'border-green-600 text-green-700 bg-white' 
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                }`}
                onClick={() => setTipoPreview('etiqueta_palete')}
              >
                <FaTags /> Etiqueta de Palete (100x150mm)
              </button>
              <button
                className={`py-3 px-6 font-medium text-sm transition-colors border-b-2 flex items-center gap-2 ${
                  tipoPreview === 'etiqueta_export' 
                    ? 'border-blue-600 text-blue-700 bg-white' 
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                }`}
                onClick={() => setTipoPreview('etiqueta_export')}
              >
                🌐 Etiqueta de Exportação (100x150mm)
              </button>
            </div>
            
            {/* Controles Manuais (Palete) */}
            {tipoPreview === 'etiqueta_palete' && (
              <div className="bg-white px-6 py-4 border-b border-gray-200">
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">TIPO:</label>
                    <input 
                      type="text" 
                      value={tipoPaleteManual}
                      onChange={(e) => setTipoPaleteManual(e.target.value.toUpperCase())}
                      className="w-full text-sm border border-gray-300 rounded px-3 py-2 focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none"
                      placeholder="Ex: USINADO"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">FIFO:</label>
                    <input 
                      type="text" 
                      value={fifoPaleteManual}
                      onChange={(e) => setFifoPaleteManual(e.target.value.toUpperCase())}
                      className="w-full text-sm border border-gray-300 rounded px-3 py-2 focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none"
                      placeholder="Ex: ÁREA A"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">STATUS:</label>
                    <select 
                      value={statusPaleteManual}
                      onChange={(e) => setStatusPaleteManual(e.target.value)}
                      className="w-full text-sm border border-gray-300 rounded px-3 py-2 focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none"
                    >
                      <option value="PRODUZIDO">PRODUZIDO</option>
                      <option value="INSPEÇÃO">INSPEÇÃO</option>
                      <option value="APROVADO">APROVADO</option>
                      <option value="BLOQUEADO">BLOQUEADO</option>
                      <option value="REPROVADO">REPROVADO</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* Controles Manuais (Exportação) */}
            {tipoPreview === 'etiqueta_export' && (
              <div className="bg-white px-6 py-4 border-b border-blue-100">
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">FIFO / ZONE:</label>
                    <input 
                      type="text" 
                      value={fifoPaleteManual}
                      onChange={(e) => setFifoPaleteManual(e.target.value.toUpperCase())}
                      className="w-full text-sm border border-gray-300 rounded px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                      placeholder="Ex: AREA A"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">DESTINATION:</label>
                    <input 
                      type="text" 
                      value={exportDestination}
                      onChange={(e) => setExportDestination(e.target.value.toUpperCase())}
                      className="w-full text-sm border border-gray-300 rounded px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                      placeholder="Ex: USA / CL / CA"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">QC STATUS:</label>
                    <select 
                      value={exportQcStatus}
                      onChange={(e) => setExportQcStatus(e.target.value)}
                      className="w-full text-sm border border-gray-300 rounded px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                    >
                      <option value="APPROVED">APPROVED</option>
                      <option value="INSPECTION">INSPECTION</option>
                      <option value="ON HOLD">ON HOLD</option>
                      <option value="REJECTED">REJECTED</option>
                    </select>
                  </div>
                </div>
              </div>
            )}
            
            {/* Conteúdo principal - Rolável se necessário */}
            <div className="p-8 bg-gradient-to-br from-gray-50 to-white overflow-y-auto flex-1">
              <div className="flex justify-center mb-6 min-h-[180px]">
                {tipoPreview === 'etiquetas' ? (
                  <EtiquetaPreview
                    lote={apontamentoPreview.lote || ''}
                    loteMP={apontamentoPreview.lote_externo || apontamentoPreview.loteExterno || ''}
                    rack={apontamentoPreview.rack_acabado || apontamentoPreview.rack_ou_pallet || apontamentoPreview.rackOuPallet || ''}
                    qtde={apontamentoPreview.quantidade || ''}
                    ferramenta={extrairFerramenta(apontamentoPreview.produto || apontamentoPreview.codigoPerfil || '')}
                    dureza={apontamentoPreview.dureza_material || ''}
                    numeroEtiqueta={1}
                    totalEtiquetas={1}
                    codigoProdutoCliente={apontamentoPreview.codigo_produto_cliente || apontamentoPreview.codigoProdutoCliente || ''}
                    nomeCliente={apontamentoPreview.cliente || ''}
                    comprimento={extrairComprimentoAcabado(apontamentoPreview.produto || apontamentoPreview.codigoPerfil || '')}
                    pedidoCliente={apontamentoPreview.pedido_cliente || apontamentoPreview.pedidoCliente || ''}
                    pedidoSeq={apontamentoPreview.ordem_trabalho || apontamentoPreview.ordemTrabalho || ''}
                  />
                ) : (() => {
                  const idPaletePreview = `PAL-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}-000000`
                  const maquinaObj = maquinas.find(m => m.id === apontamentoPreview.maquina)
                  const maquinaNome = maquinaObj ? maquinaObj.nome : apontamentoPreview.maquina
                  const loteExtrusao = extrairLoteExtrusao(apontamentoPreview)
                  const loteMP = extrairLoteMP(apontamentoPreview)
                  const descricaoProduto = `${extrairFerramenta(apontamentoPreview.produto || apontamentoPreview.codigoPerfil || '')} - ${extrairComprimentoAcabado(apontamentoPreview.produto || apontamentoPreview.codigoPerfil || '')}mm`
                  const clienteNome = apontamentoPreview.cliente || apontamentoPreview.nome_cliente || ''
                  const codigoClienteVal = apontamentoPreview.codigo_produto_cliente || apontamentoPreview.codigoProdutoCliente || ''
                  const pedidoVal = apontamentoPreview.ordem_trabalho || apontamentoPreview.ordemTrabalho || apontamentoPreview.pedido_seq || ''
                  const rackVal = apontamentoPreview.rack_acabado || apontamentoPreview.rack_ou_pallet || apontamentoPreview.rackOuPallet || ''
                  const dataHoje = new Date().toLocaleDateString('pt-BR')

                  if (tipoPreview === 'etiqueta_export') {
                    return (
                      <EtiquetaPaleteExportPreview
                        idPalete={idPaletePreview}
                        codigoProduto={apontamentoPreview.produto || apontamentoPreview.codigoPerfil || ''}
                        descricao={descricaoProduto}
                        cliente={clienteNome}
                        codigoCliente={codigoClienteVal}
                        pedido={pedidoVal}
                        quantidade={apontamentoPreview.quantidade || ''}
                        lote={loteExtrusao}
                        loteMP={loteMP}
                        rack={rackVal}
                        maquina={maquinaNome || ''}
                        operador={apontamentoPreview.operador || ''}
                        dataProducao={dataHoje}
                        tipo="MACHINED / USINADO"
                        status="PRODUCED / PRODUZIDO"
                        dureza={apontamentoPreview.dureza_material || ''}
                        fifo={fifoPaleteManual || 'AREA A'}
                        hsCode="7604.29.90"
                        countryOfOrigin="MADE IN BRAZIL"
                        destination={exportDestination}
                        qcStatus={exportQcStatus}
                      />
                    )
                  }

                  return (
                    <EtiquetaPaletePreview
                      idPalete={idPaletePreview}
                      codigoProduto={apontamentoPreview.produto || apontamentoPreview.codigoPerfil || ''}
                      descricao={descricaoProduto}
                      cliente={clienteNome}
                      codigoCliente={codigoClienteVal}
                      pedido={pedidoVal}
                      quantidade={apontamentoPreview.quantidade || ''}
                      lote={loteExtrusao}
                      loteMP={loteMP}
                      rack={rackVal}
                      maquina={maquinaNome || ''}
                      operador={apontamentoPreview.operador || ''}
                      dataProducao={dataHoje}
                      tipo={tipoPaleteManual}
                      status={statusPaleteManual}
                      dureza={apontamentoPreview.dureza_material || ''}
                      fifo={fifoPaleteManual}
                      qrCodeUrl={qrCodePaletePreviewUrl}
                    />
                  )
                })()}
              </div>
              
              {/* Informações adicionais */}
              <div className="bg-gray-100 rounded-xl p-4 mb-6 max-w-2xl mx-auto">
                <h4 className="font-semibold text-gray-800 mb-3 text-center">Informações do Apontamento</h4>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-gray-600">Produto:</span>
                    <span className="ml-2 font-medium text-gray-800">{apontamentoPreview.produto || apontamentoPreview.codigoPerfil || 'N/A'}</span>
                  </div>
                  <div>
                    <span className="text-gray-600">Quantidade:</span>
                    <span className="ml-2 font-medium text-gray-800">{apontamentoPreview.quantidade || '0'} PC</span>
                  </div>
                  <div>
                    <span className="text-gray-600">Lote:</span>
                    <span className="ml-2 font-medium text-gray-800">{apontamentoPreview.lote || 'N/A'}</span>
                  </div>
                  <div>
                    <span className="text-gray-600">Rack Acabado:</span>
                    <span className="ml-2 font-medium text-gray-800">{apontamentoPreview.rack_acabado || 'N/A'}</span>
                  </div>
                </div>
              </div>
              
              {/* Botões de ação */}
              <div className="flex gap-4 max-w-2xl mx-auto">
                <button
                  className="flex-1 px-6 py-3 bg-gray-600 text-white rounded-xl hover:bg-gray-700 transition-all flex items-center justify-center gap-2"
                  onClick={() => setEtiquetaPreviewAberta(false)}
                >
                  <FaTimes />
                  <span>Fechar</span>
                </button>
                <button
                  className="flex-1 px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-all flex items-center justify-center gap-2"
                  onClick={() => {
                    setEtiquetaPreviewAberta(false)
                    // Abrir o menu de reimpressão para este apontamento com o tipo selecionado
                    setTipoReimpressao(tipoPreview)
                    setMenuReimpressaoAberto(apontamentoPreview)
                    setReimpressaoDistribuicao([{ qtdPorEtiqueta: apontamentoPreview.quantidade || '', qtdEtiquetas: '1' }])
                  }}
                >
                  <FaPrint />
                  <span>Imprimir</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* Modal de visualização/upload da foto da ferramenta */}
      {fotoModalAberta && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black bg-opacity-80 backdrop-blur-sm" onClick={() => setFotoModalAberta(false)}></div>
          <div className="relative bg-white rounded-2xl shadow-2xl max-w-5xl max-h-[90vh] w-full mx-4 overflow-hidden">
            {/* Header com gradiente */}
            <div className="relative bg-gradient-to-r from-blue-600 to-blue-700 p-6 text-white">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 bg-white/20 rounded-xl flex items-center justify-center backdrop-blur-sm">
                    <FaImage className="text-2xl" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold">Foto do Perfil de Corte</h3>
                    <p className="text-blue-100 text-sm mt-1">
                      {formData.codigoPerfil ? `Ferramenta: ${extrairFerramenta(formData.codigoPerfil)}` : 'Visualização da foto'}
                    </p>
                  </div>
                </div>
                <button
                  className="w-10 h-10 bg-white/20 rounded-lg flex items-center justify-center hover:bg-white/30 transition-all backdrop-blur-sm"
                  onClick={() => setFotoModalAberta(false)}
                >
                  <FaTimes className="text-lg" />
                </button>
              </div>
            </div>
            
            {/* Conteúdo principal */}
            <div className="p-8 bg-gradient-to-br from-gray-50 to-white">
              <div className="flex justify-center mb-8">
                {fotoUrlVisualizacao ? (
                  <div className="relative group">
                    <img
                      src={fotoUrlVisualizacao}
                      alt="Foto do perfil de corte"
                      className="max-w-full max-h-[60vh] object-contain rounded-2xl shadow-2xl border-2 border-gray-200 transition-transform group-hover:scale-[1.02]"
                      onError={(e) => {
                        e.target.style.display = 'none'
                        e.target.nextSibling.style.display = 'flex'
                      }}
                    />
                    {!fotoUrlVisualizacao && (
                      <div className="w-full max-w-3xl h-80 bg-gradient-to-br from-gray-100 to-gray-200 rounded-2xl border-2 border-dashed border-gray-300 flex items-center justify-center">
                        <div className="text-center">
                          <FaImage className="text-gray-400 text-6xl mb-4 mx-auto" />
                          <p className="text-gray-500 text-lg">Nenhuma foto disponível</p>
                          <p className="text-gray-400 text-sm mt-2">Adicione uma foto para melhor visualização</p>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="w-full max-w-3xl h-80 bg-gradient-to-br from-gray-100 to-gray-200 rounded-2xl border-2 border-dashed border-gray-300 flex items-center justify-center">
                    <div className="text-center">
                      <FaImage className="text-gray-400 text-6xl mb-4 mx-auto" />
                      <p className="text-gray-500 text-lg">Nenhuma foto disponível</p>
                      <p className="text-gray-400 text-sm mt-2">Adicione uma foto para melhor visualização</p>
                    </div>
                  </div>
                )}
              </div>
              
              {/* Área de ações */}
              <div className="flex flex-col items-center gap-4">
                {(isAdmin() || user?.nivel_acesso?.toLowerCase().includes('super')) && (
                  <div className="flex flex-col sm:flex-row gap-4 items-center">
                    <button
                      type="button"
                      className="px-8 py-3 bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-xl hover:from-blue-700 hover:to-blue-800 transition-all flex items-center gap-3 shadow-lg hover:shadow-xl transform hover:-translate-y-0.5"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <FaUpload className="text-lg" />
                      <span className="font-medium">Enviar Nova Foto</span>
                    </button>
                    
                    {fotoUrlVisualizacao && (
                      <div className="flex items-center gap-2 px-4 py-2 bg-green-100 text-green-700 rounded-lg">
                        <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                        <span className="text-sm font-medium">Foto carregada</span>
                      </div>
                    )}
                  </div>
                )}
                
                {!isAdmin() && !user?.nivel_acesso?.toLowerCase().includes('super') && (
                  <div className="text-center p-6 bg-amber-50 rounded-xl border border-amber-200 max-w-md">
                    <div className="flex items-center justify-center gap-2 mb-2">
                      <div className="w-8 h-8 bg-amber-200 rounded-full flex items-center justify-center">
                        <FaImage className="text-amber-600 text-sm" />
                      </div>
                      <span className="font-medium text-amber-800">Apenas visualização</span>
                    </div>
                    <p className="text-sm text-amber-700">
                      Apenas administradores ou supervisores podem alterar as fotos do perfil.
                    </p>
                    {fotoUrlVisualizacao && (
                      <div className="mt-3 flex items-center justify-center gap-2 text-green-600">
                        <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                        <span className="text-xs font-medium">Foto disponível para visualização</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            
            {/* Footer sutil */}
            <div className="px-8 py-4 bg-gray-50 border-t border-gray-100">
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>Clique fora para fechar</span>
                <span>Suporta: JPG, PNG, WEBP (máx. 10MB)</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Inspeção de Qualidade */}
      <InspecaoQualidadeModal
        isOpen={inspecaoAberta}
        onClose={() => {
          setInspecaoAberta(false)
          setApontamentoParaInspecao(null)
        }}
        apontamento={apontamentoParaInspecao}
        onInspecaoSalva={(dataInspecao) => {
          console.log('Inspeção salva:', dataInspecao)
          // Aqui você pode adicionar lógica adicional após salvar a inspeção
        }}
      />

      {/* Modal de Senha para Editar pcs/Palete */}
      {modalSenhaPcsPalete && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center">
          <div className="absolute inset-0 bg-black bg-opacity-50" onClick={() => setModalSenhaPcsPalete(false)}></div>
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md p-6">
            <h3 className="text-lg font-bold text-gray-800 mb-4">Alterar pcs/Palete</h3>
            <p className="text-sm text-gray-600 mb-4">
              Esta ação requer senha de administrador.
            </p>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">Senha do Administrador</label>
              <input
                type="password"
                value={senhaAdmin}
                onChange={(e) => setSenhaAdmin(e.target.value)}
                className="input-field w-full"
                placeholder="Digite a senha"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleValidarSenhaPcsPalete()
                  }
                }}
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setModalSenhaPcsPalete(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleValidarSenhaPcsPalete}
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Editar pcs/Palete */}
      {modalEditarPcsPalete && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center">
          <div className="absolute inset-0 bg-black bg-opacity-50" onClick={() => setModalEditarPcsPalete(false)}></div>
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md p-6">
            <h3 className="text-lg font-bold text-gray-800 mb-4">Editar pcs/{estatisticasProduto.tipoEmbalagem}</h3>
            <p className="text-sm text-gray-600 mb-4">
              Produto: <strong>{formData.produto}</strong><br />
              Valor atual: <strong>{estatisticasProduto.pcsPorPalete}</strong>
            </p>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Novo valor (pcs/{estatisticasProduto.tipoEmbalagem})
              </label>
              <input
                type="number"
                value={novoPcsPalete}
                onChange={(e) => setNovoPcsPalete(e.target.value)}
                className="input-field w-full"
                placeholder="Digite o novo valor"
                autoFocus
              />
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Pcs por Amarrado (padrão)
              </label>
              <input
                type="number"
                value={novoPcsAmarrado}
                onChange={(e) => setNovoPcsAmarrado(e.target.value)}
                className="input-field w-full"
                placeholder="Ex: 50, 100..."
              />
              {estatisticasProduto.pcsPorAmarrado > 0 && (
                <p className="text-xs text-gray-400 mt-1">Valor atual: <strong>{estatisticasProduto.pcsPorAmarrado}</strong> pcs/amarrado</p>
              )}
            </div>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setModalEditarPcsPalete(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleSalvarNovoPcsPalete}
              >
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ApontamentosUsinagem
