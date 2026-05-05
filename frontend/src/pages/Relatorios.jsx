import { useEffect, useMemo, useState } from 'react'
import { FaPrint, FaClock, FaChartLine, FaExclamationTriangle, FaCheckCircle, FaUsers, FaIndustry, FaTachometerAlt, FaCalendarAlt } from 'react-icons/fa'
import { useSupabase } from '../hooks/useSupabase'
import supabaseService from '../services/SupabaseService'
import PrintModal from '../components/PrintModal'
import { buildFormularioIdentificacaoHtml, resolverNomeKit } from '../utils/formularioIdentificacao'
import * as XLSX from 'xlsx'

// Helpers (fora do componente) para evitar problemas de hoisting/TDZ
export function extrairComprimentoAcabado(produto) {
  if (!produto) return ''
  const resto = String(produto).slice(8)
  const match = resto.match(/^\d+/)
  const valor = match ? parseInt(match[0], 10) : null
  return Number.isFinite(valor) ? `${valor} mm` : ''
}

export function extrairFerramenta(produto) {
  if (!produto) return ''
  const s = String(produto).toUpperCase()
  // Aceitar quaisquer letras (vogais ou consoantes) no prefixo
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

const getTodayDateInput = () => {
  const pad = (n) => String(n).padStart(2, '0')
  const hoje = new Date()
  const ano = hoje.getFullYear()
  const mes = pad(hoje.getMonth() + 1)
  const dia = pad(hoje.getDate())
  return `${ano}-${mes}-${dia}`
}

const get7BusinessDaysAgoDateInput = () => {
  const pad = (n) => String(n).padStart(2, '0')
  const data = new Date()
  let diasUteis = 0
  
  while (diasUteis < 7) {
    data.setDate(data.getDate() - 1)
    const diaSemana = data.getDay()
    // 0 = domingo, 6 = sábado
    if (diaSemana !== 0 && diaSemana !== 6) {
      diasUteis++
    }
  }
  
  const ano = data.getFullYear()
  const mes = pad(data.getMonth() + 1)
  const dia = pad(data.getDate())
  return `${ano}-${mes}-${dia}`
}

const Relatorios = () => {
  const [filtros, setFiltros] = useState(() => ({
    tipoRelatorio: 'producao',
    dataInicio: getTodayDateInput(),
    dataFim: '',
    maquina: '',
    operador: '',
    cliente: '', // filtro por cliente
    pedidoCliente: '', // filtro por pedido cliente
    produto: '', // filtro por produto
    rack: '', // filtro por rack/pallet
    ferramenta: '', // filtro por ferramenta
    comprimento: '', // filtro por comprimento (ex: "810 mm")
    formato: 'excel',
    modo: 'detalhado' // para rastreabilidade: detalhado|compacto
  }))
  const [filtrosAberto, setFiltrosAberto] = useState(true)
  const [printModalAberto, setPrintModalAberto] = useState(false)
  const [apontamentoSelecionado, setApontamentoSelecionado] = useState(null)
  const [impressoesEtiquetasPorApontamento, setImpressoesEtiquetasPorApontamento] = useState({})
  
  // Dados reais do IndexedDB
  const { items: apontamentos } = useSupabase('apontamentos')
  const { items: paradasRaw } = useSupabase('apontamentos_parada')
  const { items: ferramentasCfg } = useSupabase('ferramentas_cfg')
  const { items: maquinasCat } = useSupabase('maquinas')
  const { items: lotesDB } = useSupabase('lotes')
  const { items: inspecoesQualidade } = useSupabase('inspecoes_qualidade')
  const { items: kitsDB } = useSupabase('expedicao_kits')
  const { items: kitComponentesDB } = useSupabase('expedicao_kit_componentes')

  // Utilitário: Agrupar rastreabilidade em modo compacto (uma linha por apontamento)
  const agruparRastreabilidadeCompacto = (linhas) => {
    const map = {}
    
    // Função auxiliar para concatenar valores únicos
    const concat = (a, b) => {
      const sa = (a ? String(a) : '').trim()
      const sb = (b ? String(b) : '').trim()
      if (!sa) return sb
      if (!sb) return sa
      // Usar Set para evitar duplicatas
      const set = new Set(sa.split(', ').filter(Boolean).concat(sb.split(', ').filter(Boolean)))
      return Array.from(set).join(', ')
    }
    
    // Lista de todos os campos de amarrado que devem ser concatenados
    const camposAmarrado = [
      'Amarrado_Codigo',
      'Amarrado_Lote',
      'Amarrado_Rack',
      'Amarrado_Produto',
      'Amarrado_PedidoSeq',
      'Amarrado_Pedido',
      'Amarrado_Seq',
      'Amarrado_Romaneio',
      'Amarrado_QtKG',
      'Amarrado_QtdPC',
      'Amarrado_Ferramenta',
      'Amarrado_Comprimento_mm'
    ]
    
    for (const r of (linhas || [])) {
      const k = `${r.ID_Apont || ''}`
      
      if (!map[k]) {
        // Primeira linha deste apontamento - copiar tudo
        map[k] = { ...r }
      } else {
        // Concatenar todos os campos de amarrado
        camposAmarrado.forEach(campo => {
          if (campo in r || campo in map[k]) {
            map[k][campo] = concat(map[k][campo] || '', r[campo] || '')
          }
        })
      }
    }
    
    const resultado = Object.values(map)
    
    // Log para debug
    console.log(`📊 Rastreabilidade Compacto: ${linhas.length} linhas → ${resultado.length} apontamentos agrupados`)
    
    return resultado
  }

  const maquinasLista = useMemo(() => {
    try {
      return (maquinasCat || [])
        .filter(m => {
          const st = String(m?.status || 'ativa').toLowerCase()
          return st === 'ativa'
        })
        .map(m => ({
          id: m?.id,
          nome: m?.nome || m?.codigo || `Máquina ${m?.id}`
        }))
        .sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'))
    } catch {
      return []
    }
  }, [maquinasCat])
  
  // Operadores dinâmicos a partir dos apontamentos reais
  const operadores = useMemo(() => {
    const nomes = Array.from(new Set((apontamentos || []).map(a => a.operador).filter(Boolean)))
    return nomes.map(n => ({ id: n, nome: n }))
  }, [apontamentos])

  const tiposRelatorio = [
    { id: 'producao', nome: 'Produção por Período' },
    { id: 'producao_usinagem', nome: 'Apontamentos - Usinagem: Produção por Período' },
    { id: 'producao_embalagem', nome: 'Apontamentos - Embalagem: Produção por Período' },
    { id: 'inspecao_qualidade', nome: 'Inspeção de Qualidade (QA)' },
    { id: 'paradas', nome: 'Paradas de Máquina' },
    { id: 'desempenho', nome: 'Desempenho por Operador/Máquina' },
    { id: 'desempenho_usinagem', nome: 'Apontamentos - Usinagem: Desempenho por Operador/Máquina' },
    { id: 'desempenho_embalagem', nome: 'Apontamentos - Embalagem: Desempenho por Operador/Máquina' },
    { id: 'oee', nome: 'OEE Detalhado' },
    { id: 'expedicao', nome: 'Estimativa de Expedição' },
    { id: 'produtividade', nome: 'Produtividade (Itens)' },
    { id: 'produtividade_usinagem', nome: 'Apontamentos - Usinagem: Produtividade (Itens)' },
    { id: 'produtividade_embalagem', nome: 'Apontamentos - Embalagem: Produtividade (Itens)' },
    { id: 'rastreabilidade', nome: 'Rastreabilidade (Amarrados/Lotes)' },
    { id: 'apontamentos_rack', nome: 'Apontamentos por Rack!Embalagem' }
  ]

  const areaPorTipoRelatorio = (tipo) => {
    if (!tipo) return null
    if (String(tipo).endsWith('_usinagem')) return 'usinagem'
    if (String(tipo).endsWith('_embalagem')) return 'embalagem'
    return null
  }

  const tipoBaseRelatorio = (tipo) => {
    if (!tipo) return ''
    return String(tipo).replace(/_(usinagem|embalagem)$/,'')
  }
  
  const handleChange = (e) => {
    const { name, value } = e.target
    setFiltros(prev => {
      const next = {
        ...prev,
        [name]: value
      }

      if (name === 'ferramenta' && prev.comprimento) {
        next.comprimento = ''
      }

      return next
    })
  }

  // Impressão do Formulário de Identificação (Word) a partir de uma linha
  const imprimirFormIdent = (a) => {
    const cliente = a.cliente || ''
    const item = (a.produto || a.codigoPerfil || '')
    const codigoCliente = a.codigo_produto_cliente || ''
    const medida = a.comprimento_acabado_mm ? `${a.comprimento_acabado_mm} mm` : extrairComprimentoAcabado(item)
    const pedidoTecno = (a.ordemTrabalho || a.ordem_trabalho || a.pedido_seq || '')
    const pedidoCli = (a.pedido_cliente || a.pedidoCliente || '')
    const qtde = a.quantidade || ''
    const pallet = (a.rack_acabado || a.rackAcabado || '')
    const lote = a.lote || ''
    const loteMPVal = a.lote_externo || a.loteExterno || 
                     (Array.isArray(a.lotes_externos) ? a.lotes_externos.join(', ') : '') || ''
    const durezaVal = (a.dureza_material && String(a.dureza_material).trim()) ? a.dureza_material : 'N/A'
    const dataHoraProducao = a.inicio || a.data_inicio || a.dataInicio || ''
    const dataProducao = dataHoraProducao ? new Date(dataHoraProducao).toLocaleDateString('pt-BR') : ''
    const turno = a.turno || ''

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
    
    // Abrir em nova janela pronta para impressão
    const printWindow = window.open('', '_blank', 'width=1100,height=800')
    printWindow.document.write(html)
    printWindow.document.close()
    setTimeout(() => {
      printWindow.print()
    }, 500)
  }
  
  // Utilitário: sanitizar nome de aba do Excel
  const sanitizeSheetName = (name) => {
    if (!name) return 'Dados'
    
    // Remover caracteres inválidos: : \ / ? * [ ]
    let sanitized = String(name).replace(/[:\\\/\?\*\[\]]/g, '')
    
    // Limitar a 31 caracteres (limite do Excel)
    if (sanitized.length > 31) {
      sanitized = sanitized.substring(0, 31)
    }
    
    // Se ficou vazio após sanitização, usar nome padrão
    return sanitized.trim() || 'Dados'
  }

  // Utilitário: gerar e baixar arquivo Excel nativo
  const downloadExcel = (rows, fileName, sheetName = 'Relatório') => {
    if (!rows || rows.length === 0) { 
      alert('Sem dados para exportar.'); 
      return 
    }

    try {
      // Criar workbook
      const wb = XLSX.utils.book_new()
      
      // Converter dados para worksheet
      const ws = XLSX.utils.json_to_sheet(rows)
      
      // Configurar largura das colunas automaticamente
      const colWidths = []
      const headers = Object.keys(rows[0] || {})
      
      headers.forEach((header, index) => {
        let maxWidth = header.length
        rows.forEach(row => {
          const cellValue = String(row[header] || '')
          if (cellValue.length > maxWidth) {
            maxWidth = cellValue.length
          }
        })
        // Limitar largura máxima para evitar colunas muito largas
        colWidths[index] = { wch: Math.min(maxWidth + 2, 50) }
      })
      
      ws['!cols'] = colWidths
      
      // Sanitizar nome da aba antes de adicionar
      const safeSheetName = sanitizeSheetName(sheetName)
      
      // Adicionar worksheet ao workbook
      XLSX.utils.book_append_sheet(wb, ws, safeSheetName)
      
      // Gerar arquivo Excel
      const excelBuffer = XLSX.write(wb, { 
        bookType: 'xlsx', 
        type: 'array',
        cellStyles: true 
      })
      
      // Criar blob e fazer download
      const blob = new Blob([excelBuffer], { 
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
      })
      
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${fileName}.xlsx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      
      console.log(`Excel gerado: ${fileName}.xlsx com ${rows.length} linhas`)
      
    } catch (error) {
      console.error('Erro ao gerar Excel:', error)
      alert('Erro ao gerar arquivo Excel: ' + error.message)
    }
  }

  // Utilitário: gerar Excel com múltiplas abas
  const downloadExcelMultiSheet = (sheetsData, fileName) => {
    if (!sheetsData || sheetsData.length === 0) {
      alert('Sem dados para exportar.')
      return
    }

    try {
      const wb = XLSX.utils.book_new()
      
      sheetsData.forEach(({ data, name }) => {
        if (data && data.length > 0) {
          const ws = XLSX.utils.json_to_sheet(data)
          
          // Auto-ajustar largura das colunas
          const colWidths = []
          const headers = Object.keys(data[0] || {})
          
          headers.forEach((header, index) => {
            let maxWidth = header.length
            data.forEach(row => {
              const cellValue = String(row[header] || '')
              if (cellValue.length > maxWidth) {
                maxWidth = cellValue.length
              }
            })
            colWidths[index] = { wch: Math.min(maxWidth + 2, 50) }
          })
          
          ws['!cols'] = colWidths
          
          // Sanitizar nome da aba antes de adicionar
          const safeSheetName = sanitizeSheetName(name || 'Dados')
          
          XLSX.utils.book_append_sheet(wb, ws, safeSheetName)
        }
      })
      
      const excelBuffer = XLSX.write(wb, { 
        bookType: 'xlsx', 
        type: 'array',
        cellStyles: true 
      })
      
      const blob = new Blob([excelBuffer], { 
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
      })
      
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${fileName}.xlsx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      
    } catch (error) {
      console.error('Erro ao gerar Excel multi-sheet:', error)
      alert('Erro ao gerar arquivo Excel: ' + error.message)
    }
  }

  // Construção das linhas para cada tipo de relatório
  const buildRows = (tipo) => {
    const base = tipoBaseRelatorio(tipo)
    switch (base) {
      case 'inspecao_qualidade': {
        return inspecoesQualidadeFiltradas.map((i) => {
          const apont = i.apontamento_id ? apontamentosPorId[i.apontamento_id] : null
          const blocos = Array.isArray(i.blocos) ? i.blocos : []
          const statusNc = Array.from(new Set(blocos.map(b => b?.statusNaoConforme).filter(Boolean)))
          const comentariosNc = Array.from(new Set(blocos.map(b => b?.comentarioNaoConforme).filter(Boolean)))

          return {
            Data: brDate(i.data_inspecao),
            Hora: i.data_inspecao ? new Date(i.data_inspecao).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '-',
            Maquina: maqMap[String(apont?.maquina)] || apont?.maquina || '-',
            Operador: i.operador || '-',
            PedidoSeq: i.pedido_seq || '-',
            Produto: i.produto || '-',
            Palete: i.palete || '-',
            Quantidade_Total: i.quantidade_total ?? 0,
            Inspecionado: i.quantidade_inspecionada ?? 0,
            Nao_Conforme: i.quantidade_nao_conforme ?? 0,
            Percentual_NC: typeof i.percentual_nao_conforme === 'number'
              ? `${Number(i.percentual_nao_conforme).toFixed(2)}%`
              : (i.percentual_nao_conforme ? `${i.percentual_nao_conforme}%` : '0%'),
            Status_Inspecao: i.status || '-',
            Status_NC: statusNc.length ? statusNc.join(', ') : '-',
            Comentarios_NC: comentariosNc.length ? comentariosNc.join(' | ') : '-'
          }
        })
      }
      case 'producao':
        return apontamentosOrdenados.map(a => {
          const duracao = duracaoMin(a.inicio, a.fim)
          return {
            Data: brDate(a.inicio),
            Hora_Inicio: brTime(a.inicio),
            Hora_Fim: brTime(a.fim),
            Duracao_min: duracao ?? '-',
            Maquina: maqMap[String(a.maquina)] || a.maquina || '-',
            Operador: a.operador || '-',
            PedidoSeq: a.ordemTrabalho || a.ordem_trabalho || a.pedido_seq || '-',
            Produto: a.produto || a.codigoPerfil || '-',
            Ferramenta: extrairFerramenta(a.produto || a.codigoPerfil) || '-',
            Quantidade: a.quantidade || 0,
            Pcs_por_Hora: duracao > 0 ? ((a.quantidade || 0) / (duracao / 60)).toFixed(1) : '-',
            Refugo: a.qtd_refugo || 0,
            RackOuPallet: a.rack_ou_pallet || a.rackOuPallet || '-',
            RackAcabado: a.rack_acabado || a.rackAcabado || '-',
            QtdPedido: a.qtd_pedido ?? a.qtdPedido ?? '-',
            Separado: a.separado ?? a.qtd_separado ?? '-'
          }
        })
      case 'paradas':
        return paradasFiltradas.map(p => ({
          Data: brDate(p.inicio_norm),
          Maquina: maqMap[String(p.maquina)] || p.maquina || '-',
          Motivo: p.motivo_norm,
          Tipo: p.tipo_norm,
          Inicio: p.inicio_norm ? new Date(p.inicio_norm).toLocaleString('pt-BR') : '-',
          Fim: p.fim_norm ? new Date(p.fim_norm).toLocaleString('pt-BR') : '-',
          Duracao_min: (duracaoMin(p.inicio_norm, p.fim_norm) ?? '-')
        }))
      case 'desempenho': {
        const by = {}
        for (const a of apontamentosFiltrados) {
          const op = a.operador || '-'
          const mq = maqMap[String(a.maquina)] || a.maquina || '-'
          const key = `${op}__${mq}`
          if (!by[key]) by[key] = { Operador: op, Maquina: mq, Producao: 0, Minutos: 0 }
          by[key].Producao += Number(a.quantidade || 0) || 0
          const m = duracaoMin(a.inicio, a.fim)
          by[key].Minutos += m || 0
        }
        return Object.values(by).map(r => ({ ...r, Prod_por_Hora: (r.Minutos > 0 ? (r.Producao / (r.Minutos/60)) : 0).toFixed(2) }))
      }
      case 'oee': {
        const by = {}
        for (const a of apontamentosFiltrados) {
          const d = toISODate(a.inicio) || '-'
          const mq = maqMap[String(a.maquina)] || a.maquina || '-'
          const k = `${d}__${mq}`
          if (!by[k]) by[k] = { Data: d, Maquina: mq, Producao: 0, ProdMin: 0, ParadaMin: 0 }
          by[k].Producao += Number(a.quantidade || 0) || 0
          by[k].ProdMin += duracaoMin(a.inicio, a.fim) || 0
        }
        for (const p of paradasFiltradas) {
          const d = toISODate(p.inicio_norm) || '-'
          const mq = maqMap[String(p.maquina)] || p.maquina || '-'
          const k = `${d}__${mq}`
          if (!by[k]) by[k] = { Data: d, Maquina: mq, Producao: 0, ProdMin: 0, ParadaMin: 0 }
          by[k].ParadaMin += duracaoMin(p.inicio_norm, p.fim_norm) || 0
        }
        return Object.values(by).sort((a,b)=> (a.Data||'').localeCompare(b.Data||''))
      }
      case 'expedicao': {
        const porItem = {}
        const cfgPorChave = {}

        for (const c of (ferramentasCfg || [])) {
          if (!c?.ferramenta) continue
          const ferramentaCfg = String(c.ferramenta || '').trim()
          const comprimentoCfg = String(c.comprimento_mm || c.comprimento || '').replace(/\D/g, '')
          const chave = `${ferramentaCfg}__${comprimentoCfg || '-'}`
          cfgPorChave[chave] = c
          if (!cfgPorChave[ferramentaCfg]) cfgPorChave[ferramentaCfg] = c
        }

        for (const a of apontamentosFiltrados) {
          const cod = (a.produto || a.codigoPerfil || '')
          const ferramenta = extrairFerramenta(cod)
          const comprimento = extrairComprimentoAcabado(cod)
          const comprimentoNum = String(comprimento || '').replace(/\D/g, '')
          if (!ferramenta) continue

          const chave = `${ferramenta}__${comprimentoNum || '-'}__${cod || '-'}`
          if (!porItem[chave]) {
            porItem[chave] = {
              Ferramenta: ferramenta,
              Produto: cod || '-',
              Comprimento_mm: comprimentoNum || '-',
              Quantidade_PCS: 0,
              Pedidos: new Set(),
              Clientes: new Set(),
              Racks: new Set(),
              Lotes: new Set()
            }
          }

          const item = porItem[chave]
          const qtd = Number(a.quantidade || 0) || 0
          item.Quantidade_PCS += qtd

          const pedido = a.ordemTrabalho || a.ordem_trabalho || a.pedido_seq || ''
          const cliente = a.cliente || ''
          const rack = a.rack_ou_pallet || a.rackOuPallet || ''
          const lote = a.lote || a.lote_externo || ''

          if (pedido) item.Pedidos.add(String(pedido).trim())
          if (cliente) item.Clientes.add(String(cliente).trim())
          if (rack) item.Racks.add(String(rack).trim())
          if (lote) item.Lotes.add(String(lote).trim())
        }

        return Object.values(porItem).map(item => {
          const chaveCfg = `${item.Ferramenta}__${String(item.Comprimento_mm || '').replace(/\D/g, '') || '-'}`
          const cfg = cfgPorChave[chaveCfg] || cfgPorChave[item.Ferramenta] || {}
          const embalagem = cfg.embalagem || 'pallet'
          const comprimentoM = (Number(cfg.comprimento_mm || item.Comprimento_mm || 0) || 0) / 1000
          const pesoLinear = Number(cfg.peso_linear || 0) || 0
          const pesoEstimadoKg = pesoLinear * comprimentoM * (Number(item.Quantidade_PCS) || 0)
          const pcsPorPallet = Number(cfg.pcs_por_pallet || 0) || 0
          const pcsPorCaixa = Number(cfg.pcs_por_caixa || 0) || 0
          const ripasPorPallet = Number(cfg.ripas_por_pallet || 0) || 0
          const teoricoPcsHora = Number(cfg.teorico_produtividade_pcs_hora || 0) || 0

          let palletsEstimados = '-'
          let caixasEstimadas = '-'
          let ripasEstimadas = '-'
          let capacidadeEmbalagemPcs = '-'

          if (embalagem === 'caixa') {
            capacidadeEmbalagemPcs = pcsPorCaixa || '-'
            caixasEstimadas = pcsPorCaixa > 0 ? Math.ceil(item.Quantidade_PCS / pcsPorCaixa) : '-'
          } else {
            capacidadeEmbalagemPcs = pcsPorPallet || '-'
            palletsEstimados = pcsPorPallet > 0 ? Math.ceil(item.Quantidade_PCS / pcsPorPallet) : '-'
            ripasEstimadas = pcsPorPallet > 0 ? Math.ceil(item.Quantidade_PCS / pcsPorPallet) * ripasPorPallet : '-'
          }

          return {
            Ferramenta: item.Ferramenta,
            Produto: item.Produto,
            Comprimento_mm: item.Comprimento_mm,
            Embalagem: embalagem,
            Capacidade_Embalagem_PCS: capacidadeEmbalagemPcs,
            Quantidade_PCS: item.Quantidade_PCS,
            Peso_Linear_kg_m: pesoLinear || '-',
            Peso_Estimado_KG: Number.isFinite(pesoEstimadoKg) ? Number(pesoEstimadoKg.toFixed(3)) : '-',
            Teorico_PCS_Hora: teoricoPcsHora || '-',
            Pallets_Estimados: palletsEstimados,
            Caixas_Estimadas: caixasEstimadas,
            Ripas_Estimadas: ripasEstimadas,
            Qtde_Racks_Pallets: item.Racks.size || 0,
            Racks_Pallets: Array.from(item.Racks).sort().join(', ') || '-',
            Qtde_Pedidos: item.Pedidos.size || 0,
            Pedidos: Array.from(item.Pedidos).sort().join(', ') || '-',
            Clientes: Array.from(item.Clientes).sort().join(', ') || '-',
            Lotes: Array.from(item.Lotes).sort().join(', ') || '-'
          }
        })
      }
      case 'produtividade': {
        const grupos = {}
        for (const a of apontamentosFiltrados) {
          const cod = (a.produto || a.codigoPerfil)
          const ferramenta = extrairFerramenta(cod)
          const comprimento = extrairComprimentoAcabado(cod)
          const key = `${ferramenta}__${comprimento}`
          if (!grupos[key]) grupos[key] = { Ferramenta: ferramenta, Comprimento: comprimento, Quantidade: 0, Minutos: 0 }
          grupos[key].Quantidade += Number(a.quantidade || 0) || 0
          grupos[key].Minutos += duracaoMin(a.inicio, a.fim) || 0
        }
        return Object.values(grupos).map(g => ({ ...g, Media_pcs_h: (g.Minutos>0?(g.Quantidade/(g.Minutos/60)):0).toFixed(2) }))
      }
      case 'apontamentos_rack': {
        // IMPORTANTE: este relatório agrupa por Rack!Embalagem (rack_embalagem do amarrado/lote).
        // Usamos a MESMA base do relatório de rastreabilidade:
        // 1) apontamentos.amarrados_detalhados (JSONB) quando existe
        // 2) fallback: tabela lotes consultando pelos lotes_externos / lote_externo do apontamento
        const porRack = {}

        const ensureRack = (rackKey) => {
          const rk = String(rackKey || '').trim()
          if (!rk) return null
          if (!porRack[rk]) {
            porRack[rk] = {
              rack: rk,
              datas: new Set(),
              lotes: new Set(),
              amarrados: new Set(),
              produtos: new Set()
            }
          }
          return porRack[rk]
        }

        for (const a of apontamentosOrdenados) {
          const dataApont = a?.inicio ? brDate(a.inicio) : ''

          const arr = Array.isArray(a.amarrados_detalhados) ? a.amarrados_detalhados : []
          if (arr.length > 0) {
            for (const am of arr) {
              const rackEmb = String(am?.rack || '').trim()
              const entry = ensureRack(rackEmb)
              if (!entry) continue
              if (dataApont) entry.datas.add(dataApont)

              const loteNum = String(am?.lote || '').trim()
              if (loteNum) entry.lotes.add(loteNum)

              const codigo = String(am?.codigo || '').trim()
              if (codigo) entry.amarrados.add(codigo)

              const prod = String(am?.produto || '').trim()
              if (prod) entry.produtos.add(prod)
            }
            continue
          }

          // Fallback: derivar pelos lotes_externos quando não há amarrados_detalhados
          const lotesExt = Array.isArray(a.lotes_externos) ? a.lotes_externos : (a.lote_externo ? [a.lote_externo] : [])
          if (lotesExt.length === 0) continue

          for (const loteNum of lotesExt) {
            const l = (lotesDB || []).find(x => String(x.lote || '').trim() === String(loteNum)) || null
            if (!l) continue

            const rackEmb = String(l.rack_embalagem || '').trim()
            const entry = ensureRack(rackEmb)
            if (!entry) continue
            if (dataApont) entry.datas.add(dataApont)

            const ln = String(l.lote || '').trim()
            if (ln) entry.lotes.add(ln)

            const codigo = String(l.codigo || '').trim()
            if (codigo) entry.amarrados.add(codigo)

            const prodBruto = String(l.produto || getCampoOriginalLote(l, 'Produto') || '').trim()
            if (prodBruto) entry.produtos.add(prodBruto)
          }
        }

        const linhas = Object.values(porRack).map((r) => ({
          'Rack!Embalagem': r.rack,
          'Dias de Apontamentos': Array.from(r.datas).sort((a, b) => String(a).localeCompare(String(b), 'pt-BR')).join(', ') || '-',
          'Lotes': Array.from(r.lotes).join(', ') || '-',
          'Qtd Amarrados': r.amarrados.size,
          'Produtos': Array.from(r.produtos).slice(0, 8).join(', ') + (r.produtos.size > 8 ? '...' : '')
        }))

        console.log(`📦 Apontamentos por Rack!Embalagem: ${linhas.length} racks`)

        return linhas.sort((a, b) => String(a['Rack!Embalagem']).localeCompare(String(b['Rack!Embalagem']), 'pt-BR'))
      }
      case 'rastreabilidade': {
        const linhas = []
        let totalAmarrados = 0
        
        for (const a of apontamentosOrdenados) {
          const base = {
            ID_Apont: a.id,
            Data: brDate(a.inicio),
            Hora: brTime(a.inicio),
            Operador: a.operador || '-',
            Maquina: maqMap[String(a.maquina)] || a.maquina || '-',
            PedidoSeq: a.ordemTrabalho || a.ordem_trabalho || a.pedido_seq || '-',
            Produto_Usinagem: a.produto || a.codigoPerfil || '-',
            Lote_Usinagem: a.lote || '-',
            Qtde_Produzida: a.quantidade || 0,
            Qtde_Refugo: a.qtd_refugo || 0,
            RackOuPallet: a.rack_ou_pallet || a.rackOuPallet || '-',
            LotesExternos: Array.isArray(a.lotes_externos) ? a.lotes_externos.join(', ') : (a.lote_externo || '')
          }
          const arr = Array.isArray(a.amarrados_detalhados) ? a.amarrados_detalhados : []
          
          if (arr.length === 0) {
            // Fallback: derivar pelos lotes_externos quando não há amarrados_detalhados
            const lotesExt = Array.isArray(a.lotes_externos) ? a.lotes_externos : (a.lote_externo ? [a.lote_externo] : [])
            if (lotesExt.length > 0) {
              for (const loteNum of lotesExt) {
                const l = (lotesDB || []).find(x => String(x.lote || '').trim() === String(loteNum)) || {}
                const prodBruto = String(l.produto || getCampoOriginalLote(l, 'Produto') || '').trim()
                const ferramentaBruta = extrairFerramenta(prodBruto) || ''
                const comprimentoLongo = extrairComprimentoAcabado(prodBruto) || ''
                const pedidoSeqBruto = String(l.pedido_seq || '')
                const [pedidoBruto, seqBruto] = pedidoSeqBruto.includes('/') ? pedidoSeqBruto.split('/') : [pedidoSeqBruto, '']
                linhas.push({
                  ...base,
                  Amarrado_Codigo: String(l.codigo || '').trim(),
                  Amarrado_Lote: String(l.lote || '').trim(),
                  Amarrado_Rack: String(l.rack_embalagem || '').trim(),
                  Amarrado_Produto: prodBruto,
                  Amarrado_Ferramenta: ferramentaBruta,
                  Amarrado_Comprimento_mm: comprimentoLongo,
                  Amarrado_PedidoSeq: pedidoSeqBruto,
                  Amarrado_Pedido: pedidoBruto || '',
                  Amarrado_Seq: seqBruto || '',
                  Amarrado_Romaneio: String(l.romaneio || '').trim(),
                  Amarrado_QtKG: Number(l.qt_kg || 0) || '',
                  Amarrado_QtdPC: Number(l.qtd_pc || 0) || ''
                })
              }
            } else {
              linhas.push(base)
            }
          } else {
            // Usar amarrados_detalhados quando disponível
            totalAmarrados += arr.length
            for (const am of arr) {
              const prodBruto = am.produto || ''
              const ferramentaBruta = extrairFerramenta(prodBruto) || ''
              const comprimentoLongo = extrairComprimentoAcabado(prodBruto) || ''
              const pedidoSeqBruto = String(am.pedido_seq || '')
              const [pedidoBruto, seqBruto] = pedidoSeqBruto.includes('/') ? pedidoSeqBruto.split('/') : [pedidoSeqBruto, '']
              linhas.push({
                ...base,
                Amarrado_Codigo: am.codigo || '',
                Amarrado_Lote: am.lote || '',
                Amarrado_Rack: am.rack || '',
                Amarrado_Produto: prodBruto,
                Amarrado_Ferramenta: ferramentaBruta,
                Amarrado_Comprimento_mm: comprimentoLongo,
                Amarrado_PedidoSeq: pedidoSeqBruto,
                Amarrado_Pedido: pedidoBruto || '',
                Amarrado_Seq: seqBruto || '',
                Amarrado_Romaneio: am.romaneio || '',
                Amarrado_QtKG: am.qt_kg ?? '',
                Amarrado_QtdPC: am.qtd_pc ?? ''
              })
            }
          }
        }
        
        console.log(`📦 Rastreabilidade Detalhado: ${apontamentosOrdenados.length} apontamentos, ${totalAmarrados} amarrados, ${linhas.length} linhas geradas`)
        
        return linhas
      }
      default:
        return []
    }
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    let rows = buildRows(filtros.tipoRelatorio)
    
    // Aplicar modo compacto para rastreabilidade
    if (tipoBaseRelatorio(filtros.tipoRelatorio) === 'rastreabilidade' && filtros.modo === 'compacto') {
      rows = agruparRastreabilidadeCompacto(rows)
    }
    
    const tipoInfo = tiposRelatorio.find(t => t.id === filtros.tipoRelatorio)
    const label = (tipoInfo?.nome || 'Relatorio').replace(/\s+/g, '_')
    const suffix = tipoBaseRelatorio(filtros.tipoRelatorio) === 'rastreabilidade' ? `_${filtros.modo}` : ''
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '')
    const fileName = `${label}${suffix}_${timestamp}`
    
    if ((filtros.formato || 'excel').toLowerCase() === 'excel') {
      // Gerar Excel nativo com nome da aba baseado no tipo de relatório
      const sheetName = tipoInfo?.nome || 'Relatório'
      downloadExcel(rows, fileName, sheetName)
    } else {
      // Formato PDF ainda não implementado: exportar Excel como fallback
      downloadExcel(rows, fileName, tipoInfo?.nome || 'Relatório')
      alert('Formato PDF ainda não implementado. O arquivo foi exportado em Excel (.xlsx).')
    }
  }

  // Função para gerar todos os relatórios em um único arquivo Excel
  const handleGerarTodosRelatorios = () => {
    try {
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '')
      const fileName = `Relatorios_Completos_${timestamp}`
      
      const sheetsData = []
      
      // Mapeamento de nomes curtos para as abas
      const nomesCurtos = {
        'producao': 'Producao',
        'producao_usinagem': 'Prod Usin',
        'producao_embalagem': 'Prod Emb',
        'paradas': 'Paradas',
        'desempenho': 'Desempenho',
        'desempenho_usinagem': 'Desemp Usin',
        'desempenho_embalagem': 'Desemp Emb',
        'oee': 'OEE',
        'expedicao': 'Expedicao',
        'produtividade': 'Produtividade',
        'produtividade_usinagem': 'Produt Usin',
        'produtividade_embalagem': 'Produt Emb',
        'rastreabilidade': 'Rastreab',
        'apontamentos_rack': 'Apont Rack'
      }
      
      // Gerar dados para cada tipo de relatório
      tiposRelatorio.forEach(tipo => {
        try {
          // Temporariamente alterar o tipo de relatório para gerar os dados
          const originalTipo = filtros.tipoRelatorio
          filtros.tipoRelatorio = tipo.id
          
          let rows = buildRows(tipo.id)
          
          // Nome curto para a aba
          const nomeBase = nomesCurtos[tipo.id] || tipo.nome
          
          // Aplicar modo compacto para rastreabilidade
          if (tipo.id === 'rastreabilidade') {
            // Gerar duas abas: detalhado e compacto
            sheetsData.push({
              data: rows,
              name: `${nomeBase} Detalhado`
            })
            
            const rowsCompacto = agruparRastreabilidadeCompacto([...rows])
            sheetsData.push({
              data: rowsCompacto,
              name: `${nomeBase} Compacto`
            })
          } else {
            sheetsData.push({
              data: rows,
              name: nomeBase
            })
          }
          
          // Restaurar tipo original
          filtros.tipoRelatorio = originalTipo
          
        } catch (error) {
          console.error(`Erro ao gerar relatório ${tipo.nome}:`, error)
        }
      })
      
      // Filtrar abas vazias
      const sheetsComDados = sheetsData.filter(sheet => sheet.data && sheet.data.length > 0)
      
      if (sheetsComDados.length === 0) {
        alert('Nenhum dado encontrado para gerar relatórios.')
        return
      }
      
      // Gerar Excel com múltiplas abas
      downloadExcelMultiSheet(sheetsComDados, fileName)
      
      alert(`Arquivo Excel gerado com ${sheetsComDados.length} abas de relatórios!`)
      
    } catch (error) {
      console.error('Erro ao gerar todos os relatórios:', error)
      alert('Erro ao gerar relatórios completos: ' + error.message)
    }
  }
  
  

  // Utilidades
  const toISODate = (val) => {
    if (!val) return null
    try { 
      // Se já está em formato YYYY-MM-DD, retorna direto
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(val))) return val
      // Caso contrário, converte
      return new Date(val).toISOString().slice(0,10) 
    } catch { return null }
  }
  const brDate = (val) => {
    if (!val) return ''
    try { const d = new Date(val); return d.toLocaleDateString('pt-BR') } catch { return String(val) }
  }
  const brTime = (val) => {
    if (!val) return ''
    try { const d = new Date(val); return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) } catch { return '' }
  }
  const fmt = (n, digits=0) => {
    try { return Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits }) } catch { return String(n) }
  }
  // Campo original do lote (dados_originais), case-insensitive
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
  // Funções extrairComprimentoAcabado e extrairFerramenta já estão definidas no topo do arquivo

  // Filtro aplicado aos apontamentos conforme controles da tela
  // Mapa id->nome da máquina
  const maqMap = useMemo(() => {
    const map = {}
    for (const m of (maquinasCat || [])) {
      if (!m) continue
      map[String(m.id)] = m.nome || m.codigo || `Máquina ${m.id}`
    }
    return map
  }, [maquinasCat])

  const normTxt = (v) => {
    try {
      return String(v ?? '').trim().toLowerCase()
    } catch {
      return ''
    }
  }

  const resolveMaquinaNome = (reg) => {
    try {
      const raw = reg?.maquina ?? reg?.maquina_nome ?? reg?.maquinaNome ?? reg?.maquina_id ?? reg?.maquinaId ?? ''
      const s = String(raw ?? '').trim()
      if (!s) return ''
      // Se for UUID/id e existir no catálogo, resolver para nome
      if (maqMap && maqMap[s]) return String(maqMap[s] || '').trim()
      return s
    } catch {
      return ''
    }
  }

  const apontamentosBaseFiltros = useMemo(() => {
    const area = areaPorTipoRelatorio(filtros.tipoRelatorio)
    const di = filtros.dataInicio ? toISODate(filtros.dataInicio) : null
    const df = filtros.dataFim ? toISODate(filtros.dataFim) : null

    return (apontamentos || []).filter(a => {
      const dd = toISODate(a.inicio)
      if (di && (!dd || dd < di)) return false
      if (df && (!dd || dd > df)) return false

      if (filtros.maquina) {
        const sel = normTxt(filtros.maquina)
        const nome = normTxt(resolveMaquinaNome(a))
        if (!nome || nome !== sel) return false
      }

      if (filtros.operador && String(a.operador) !== String(filtros.operador)) return false

      if (filtros.cliente) {
        const clienteApontamento = String(a.cliente || '').toLowerCase()
        const clienteFiltro = String(filtros.cliente).toLowerCase()
        if (!clienteApontamento.includes(clienteFiltro)) return false
      }

      if (filtros.pedidoCliente) {
        const pedidoClienteApontamento = String(a.pedido_cliente || '').toLowerCase()
        const pedidoClienteFiltro = String(filtros.pedidoCliente).toLowerCase()
        if (!pedidoClienteApontamento.includes(pedidoClienteFiltro)) return false
      }

      const produtoValor = String(a?.produto || a?.codigoPerfil || '')
      if (filtros.produto && !produtoValor.toLowerCase().includes(String(filtros.produto).toLowerCase())) return false

      const rackValor = String(a?.rack_ou_pallet || a?.rackOuPallet || '')
      if (filtros.rack && !rackValor.toLowerCase().includes(String(filtros.rack).toLowerCase())) return false

      if (area === 'embalagem') {
        if (String(a.exp_unidade || '').toLowerCase() !== 'embalagem') return false
      }
      if (area === 'usinagem') {
        if (String(a.exp_unidade || '').toLowerCase() === 'embalagem') return false
      }

      return true
    })
  }, [apontamentos, filtros, maqMap])

  const ferramentasLista = useMemo(() => {
    const set = new Set()
    for (const a of apontamentosBaseFiltros) {
      const cod = a?.produto || a?.codigoPerfil
      const f = extrairFerramenta(cod)
      if (f) set.add(f)
    }
    return Array.from(set).sort((a, b) => String(a).localeCompare(String(b), 'pt-BR'))
  }, [apontamentosBaseFiltros])

  const comprimentosLista = useMemo(() => {
    const set = new Set()
    for (const a of apontamentosBaseFiltros) {
      const cod = a?.produto || a?.codigoPerfil
      const f = extrairFerramenta(cod)
      const c = extrairComprimentoAcabado(cod)
      if (filtros.ferramenta && f !== filtros.ferramenta) continue
      if (c) set.add(c)
    }
    return Array.from(set).sort((a, b) => {
      const na = parseInt(String(a).replace(/\D/g, ''), 10) || 0
      const nb = parseInt(String(b).replace(/\D/g, ''), 10) || 0
      return na - nb
    })
  }, [apontamentosBaseFiltros, filtros.ferramenta])

  const apontamentosFiltrados = useMemo(() => {
    return apontamentosBaseFiltros.filter(a => {
      const cod = a?.produto || a?.codigoPerfil
      if (filtros.ferramenta) {
        const f = extrairFerramenta(cod)
        if (f !== filtros.ferramenta) return false
      }
      if (filtros.comprimento) {
        const c = extrairComprimentoAcabado(cod)
        if (c !== filtros.comprimento) return false
      }
      return true
    })
  }, [apontamentosBaseFiltros, filtros.ferramenta, filtros.comprimento])

  const apontamentosPorId = useMemo(() => {
    const map = {}
    for (const a of (apontamentos || [])) {
      if (a?.id) map[a.id] = a
    }
    return map
  }, [apontamentos])

  const inspecoesQualidadeFiltradas = useMemo(() => {
    const di = filtros.dataInicio ? toISODate(filtros.dataInicio) : null
    const df = filtros.dataFim ? toISODate(filtros.dataFim) : null

    return (inspecoesQualidade || []).filter((i) => {
      const dataInspecao = toISODate(i.data_inspecao)
      if (di && (!dataInspecao || dataInspecao < di)) return false
      if (df && (!dataInspecao || dataInspecao > df)) return false

      if (filtros.operador && String(i.operador || '') !== String(filtros.operador)) return false

      const produtoValor = String(i?.produto || '')
      if (filtros.produto && !produtoValor.toLowerCase().includes(String(filtros.produto).toLowerCase())) return false

      if (filtros.pedidoCliente) {
        const pedido = String(i.pedido_seq || '').toLowerCase()
        const filtro = String(filtros.pedidoCliente).toLowerCase()
        if (!pedido.includes(filtro)) return false
      }

      const rackValor = String(i?.palete || '')
      if (filtros.rack && !rackValor.toLowerCase().includes(String(filtros.rack).toLowerCase())) return false

      if (filtros.ferramenta) {
        const f = extrairFerramenta(produtoValor)
        if (f !== filtros.ferramenta) return false
      }

      if (filtros.comprimento) {
        const c = extrairComprimentoAcabado(produtoValor)
        if (c !== filtros.comprimento) return false
      }

      if (filtros.maquina) {
        const apont = i.apontamento_id ? apontamentosPorId[i.apontamento_id] : null
        const nome = normTxt(resolveMaquinaNome(apont))
        const sel = normTxt(filtros.maquina)
        if (sel && nome !== sel) return false
      }

      return true
    })
  }, [inspecoesQualidade, filtros, apontamentosPorId, maqMap])

  // Ordena do mais recente para o mais antigo
  const apontamentosOrdenados = useMemo(() => {
    const copia = [...(apontamentosFiltrados || [])]
    copia.sort((a, b) => {
      const ta = a && a.inicio ? new Date(a.inicio).getTime() : 0
      const tb = b && b.inicio ? new Date(b.inicio).getTime() : 0
      return tb - ta
    })
    return copia
  }, [apontamentosFiltrados])

  useEffect(() => {
    let cancelado = false

    const carregarContadorImpressoes = async () => {
      try {
        const ids = Array.from(new Set((apontamentosOrdenados || []).map(a => a?.id).filter(Boolean)))
        if (ids.length === 0) {
          if (!cancelado) setImpressoesEtiquetasPorApontamento({})
          return
        }

        const etiquetas = await supabaseService.getByIn('etiquetas_geradas', 'apontamento_id', ids)
        const map = {}
        for (const e of (etiquetas || [])) {
          const k = e?.apontamento_id
          if (!k) continue
          map[k] = (map[k] || 0) + 1
        }

        if (!cancelado) setImpressoesEtiquetasPorApontamento(map)
      } catch {
        if (!cancelado) setImpressoesEtiquetasPorApontamento({})
      }
    }

    carregarContadorImpressoes()
    return () => { cancelado = true }
  }, [apontamentosOrdenados])

  // Filtro aplicado às paradas
  // Normaliza paradas vindas da view/tabela
  const paradas = useMemo(() => {
    return (paradasRaw || []).map(p => ({
      ...p,
      inicio_norm: p.inicio || p.inicio_timestamp,
      fim_norm: p.fim || p.fim_timestamp,
      motivo_norm: p.motivo_parada || p.motivoParada || '-',
      tipo_norm: p.tipo_parada || p.tipoParada || '-',
    }))
  }, [paradasRaw])

  const paradasFiltradas = useMemo(() => {
    const di = filtros.dataInicio ? toISODate(filtros.dataInicio) : null
    const df = filtros.dataFim ? toISODate(filtros.dataFim) : null
    return (paradas || []).filter(p => {
      const dd = toISODate(p.inicio_norm)
      if (di && (!dd || dd < di)) return false
      if (df && (!dd || dd > df)) return false
      if (filtros.maquina) {
        const sel = normTxt(filtros.maquina)
        const nome = normTxt(resolveMaquinaNome(p))
        if (!nome || nome !== sel) return false
      }
      // Operador não se aplica a paradas (não temos esse campo), então ignorar
      return true
    })
  }, [paradas, filtros])

  const duracaoMin = (inicio, fim) => {
    if (!inicio || !fim) return null
    try {
      const di = new Date(inicio)
      const df = new Date(fim)
      return Math.max(0, Math.round((df - di) / 60000))
    } catch { return null }
  }

  // Componente para visualização prévia do relatório
  const PreviewRelatorio = ({ tipo }) => {
    const baseTipo = tipoBaseRelatorio(tipo)
    // Agregações reais
    const desempenhoAgregado = useMemo(() => {
      const map = {}
      for (const a of apontamentosFiltrados) {
        const op = a.operador || '-'
        const maq = a.maquina || '-'
        const key = `${op}__${maq}`
        if (!map[key]) map[key] = { operador: op, maquina: maq, producao: 0, minutos: 0 }
        const qtd = Number(a.quantidade || 0)
        map[key].producao += isNaN(qtd) ? 0 : qtd
        const m = duracaoMin(a.inicio, a.fim)
        map[key].minutos += m || 0
      }
      return Object.values(map)
    }, [apontamentosFiltrados])
    
    // Flags de "apontado no segundo sistema" (persistência local)
    const STORAGE_FLAG = 'relatorio_flags_segundo_sistema'
    const readFlags = () => {
      try { const raw = localStorage.getItem(STORAGE_FLAG); return raw ? JSON.parse(raw) : {} } catch { return {} }
    }
    const writeFlags = (obj) => {
      try { localStorage.setItem(STORAGE_FLAG, JSON.stringify(obj)) } catch {}
    }
    const [flags, setFlags] = useState(readFlags())
    const rowId = (a) => `${a.inicio || ''}__${a.operador || ''}__${a.maquina || ''}__${a.codigoPerfil || ''}__${a.quantidade || ''}`
    const toggleFlag = (a) => {
      const id = rowId(a)
      const next = { ...flags, [id]: !flags[id] }
      setFlags(next)
      writeFlags(next)
    }

    // Overrides de produtividade (ajustes manuais)
    const STORAGE_OVR = 'produtividade_overrides'
    const readOverrides = () => {
      try { const raw = localStorage.getItem(STORAGE_OVR); return raw ? JSON.parse(raw) : {} } catch { return {} }
    }
    const writeOverrides = (obj) => {
      try { localStorage.setItem(STORAGE_OVR, JSON.stringify(obj)) } catch {}
    }
    const [overrides, setOverrides] = useState(readOverrides())
    const setOverride = (key, field, val) => {
      const next = { ...overrides, [key]: { ...(overrides[key] || {}), [field]: val } }
      setOverrides(next)
      writeOverrides(next)
    }

    // Renderiza a tabela de acordo com o tipo de relatório
    switch (baseTipo) {
      case 'inspecao_qualidade': {
        const rows = buildRows('inspecao_qualidade')
        return (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Data</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Hora</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Máquina</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Operador</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Pedido/Seq</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Produto</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Palete</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Qtd Total</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Inspecionado</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Não Conforme</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">% NC</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status NC</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Comentário NC</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {(rows || []).map((r, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600">{r.Data}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600">{r.Hora}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600">{r.Maquina}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600">{r.Operador}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600">{r.PedidoSeq}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600 max-w-[200px] truncate" title={r.Produto}>{r.Produto}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600">{r.Palete}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm font-semibold text-gray-800">{fmt(r.Quantidade_Total)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700">{fmt(r.Inspecionado)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700">{fmt(r.Nao_Conforme)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700">{r.Percentual_NC}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700">{r.Status_Inspecao}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700">{r.Status_NC}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700 max-w-[220px] truncate" title={r.Comentarios_NC}>{r.Comentarios_NC}</td>
                  </tr>
                ))}
                {(!rows || rows.length === 0) && (
                  <tr>
                    <td colSpan="14" className="px-6 py-6 text-center text-gray-500">Nenhuma inspeção encontrada no período/seleção</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )
      }
      case 'producao':
        return (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Data</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Início</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Fim</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Duração</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Máquina</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Operador</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Pedido/Seq</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Produto</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Qtd</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Pcs/h</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Refugo</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Rack</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Imp.</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Ações</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {apontamentosOrdenados.map((a, index) => {
                  const duracao = duracaoMin(a.inicio, a.fim)
                  const pcsHora = duracao > 0 ? ((a.quantidade || 0) / (duracao / 60)).toFixed(1) : '-'
                  const pcsHoraFormatado = pcsHora !== '-' ? Number(pcsHora).toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : '-'
                  const imp = impressoesEtiquetasPorApontamento[a?.id] || 0
                  return (
                    <tr key={index} className="hover:bg-gray-50">
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600">{brDate(a.inicio)}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600">{brTime(a.inicio)}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600">{brTime(a.fim) || '-'}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm font-medium">
                        <span className={`px-2 py-1 rounded text-xs ${duracao ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-500'}`}>
                          {duracao ? `${duracao} min` : '-'}
                        </span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600">{maqMap[String(a.maquina)] || a.maquina || '-'}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600">{a.operador || '-'}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600">
                        {a.ordemTrabalho || a.ordem_trabalho || a.pedido_seq || '-'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600 max-w-[150px] truncate" title={a.produto || a.codigoPerfil}>
                        {a.produto || a.codigoPerfil || '-'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm font-semibold text-gray-800">{Number(a.quantidade || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm">
                        <span className={`font-medium ${pcsHora !== '-' && parseFloat(pcsHora) > 0 ? 'text-green-600' : 'text-gray-400'}`}>
                          {pcsHoraFormatado}
                        </span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm">
                        <span className={`${(a.qtd_refugo || 0) > 0 ? 'text-red-600 font-medium' : 'text-gray-400'}`}>
                          {a.qtd_refugo || 0}
                        </span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-500">{a.rack_ou_pallet || a.rackOuPallet || '-'}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm font-semibold text-gray-800">{imp}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm">
                        <button type="button" className="p-1.5 rounded border border-gray-300 text-gray-500 hover:bg-gray-100 hover:text-gray-700" title="Imprimir formulário ou etiquetas" onClick={() => { setApontamentoSelecionado(a); setPrintModalAberto(true) }}>
                          <FaPrint className="w-3 h-3" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
                {apontamentosOrdenados.length === 0 && (
                  <tr>
                    <td colSpan="14" className="px-6 py-8 text-center text-gray-500">
                      <div className="flex flex-col items-center gap-2">
                        <FaCalendarAlt className="w-8 h-8 text-gray-300" />
                        <span>Nenhum apontamento encontrado no período selecionado</span>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )
      
      case 'paradas':
        return (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Data</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Máquina</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Motivo</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tipo</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Início</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Fim</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Duração (min)</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {paradasFiltradas.map((p, index) => (
                <tr key={index}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{brDate(p.inicio_norm)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{maqMap[String(p.maquina)] || p.maquina || '-'}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{p.motivo_norm}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{(() => {
                    const tp = p.tipo_norm
                    return tp === 'setup' ? 'Setup' : tp === 'nao_planejada' ? 'Não Planejada' : tp === 'manutencao' ? 'Manutenção' : tp === 'planejada' ? 'Planejada' : (tp || '-')
                  })()}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{p.inicio_norm ? new Date(p.inicio_norm).toLocaleString('pt-BR') : '-'}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{p.fim_norm ? new Date(p.fim_norm).toLocaleString('pt-BR') : '-'}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{(() => { const m = duracaoMin(p.inicio_norm, p.fim_norm); return m != null ? m : '-'; })()}</td>
                </tr>
              ))}
              {paradasFiltradas.length === 0 && (
                <tr>
                  <td colSpan="7" className="px-6 py-6 text-center text-gray-500">Nenhuma parada encontrada</td>
                </tr>
              )}
            </tbody>
          </table>
        )
      
      case 'desempenho':
        return (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Operador</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Máquina</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Produção</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Horas (apontadas)</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Prod./Hora</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {desempenhoAgregado.map((item, index) => {
                const horas = (item.minutos || 0) / 60
                const pph = horas > 0 ? (item.producao / horas).toFixed(2) : '-'
                return (
                  <tr key={index}>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{item.operador}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{maqMap[String(item.maquina)] || item.maquina}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{item.producao}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{horas.toFixed(2)}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{pph}</td>
                  </tr>
                )
              })}
              {desempenhoAgregado.length === 0 && (
                <tr>
                  <td colSpan="5" className="px-6 py-6 text-center text-gray-500">Sem dados no período/seleção</td>
                </tr>
              )}
            </tbody>
          </table>
        )
      
      case 'oee':
        // OEE detalhado: apresentamos dados reais disponíveis (produção e paradas) por dia/máquina
        const byKey = {}
        for (const a of apontamentosFiltrados) {
          const dia = toISODate(a.inicio) || '-'
          const maq = a.maquina || '-'
          const key = `${dia}__${maq}`
          if (!byKey[key]) byKey[key] = { dia, maquina: maq, producao: 0, prodMin: 0, paradaMin: 0 }
          const qtd = Number(a.quantidade || 0); byKey[key].producao += isNaN(qtd) ? 0 : qtd
          const m = duracaoMin(a.inicio, a.fim); byKey[key].prodMin += m || 0
        }
        for (const p of paradasFiltradas) {
          const dia = toISODate(p.inicio) || '-'
          const maq = p.maquina || '-'
          const key = `${dia}__${maq}`
          if (!byKey[key]) byKey[key] = { dia, maquina: maq, producao: 0, prodMin: 0, paradaMin: 0 }
          const m = duracaoMin(p.inicio, p.fim); byKey[key].paradaMin += m || 0
        }
        const linhas = Object.values(byKey).sort((a,b)=> (a.dia||'').localeCompare(b.dia||''))
        return (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Data</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Máquina</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Produção</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tempo Produção (min)</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tempo Paradas (min)</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">OEE</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {linhas.map((r, idx) => (
                <tr key={idx}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{r.dia ? r.dia.split('-').reverse().join('/') : '-'}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{r.maquina}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{r.producao}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{r.prodMin}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{r.paradaMin}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">-</td>
                </tr>
              ))}
              {linhas.length === 0 && (
                <tr>
                  <td colSpan="6" className="px-6 py-6 text-center text-gray-500">Sem dados suficientes para OEE</td>
                </tr>
              )}
            </tbody>
          </table>
        )
      
      case 'expedicao': {
        // Agregar quantidade por ferramenta e unir com cfg
        const porFerramenta = {}
        for (const a of apontamentosFiltrados) {
          const cod = (a.produto || a.codigoPerfil)
          const ferramenta = extrairFerramenta(cod)
          if (!ferramenta) continue
          if (!porFerramenta[ferramenta]) porFerramenta[ferramenta] = { ferramenta, quantidade: 0 }
          const q = Number(a.quantidade || 0)
          porFerramenta[ferramenta].quantidade += isNaN(q) ? 0 : q
        }
        const cfgMap = {}
        for (const c of (ferramentasCfg || [])) {
          if (!c || !c.ferramenta) continue
          cfgMap[c.ferramenta] = c
        }
        const linhas = Object.values(porFerramenta).map(l => {
          const c = cfgMap[l.ferramenta] || {}
          const embalagem = c.embalagem || 'pallet'
          const comprimento_m = (Number(c.comprimento_mm) || 0) / 1000
          const peso_linear = Number(c.peso_linear) || 0
          const peso_estimado = peso_linear * comprimento_m * (Number(l.quantidade) || 0)
          let pallets = '-'
          let ripas = '-'
          let caixas = '-'
          if (embalagem === 'pallet') {
            const ppp = Number(c.pcs_por_pallet) || 0
            const rpp = Number(c.ripas_por_pallet) || 0
            pallets = ppp > 0 ? Math.ceil(l.quantidade / ppp) : '-'
            ripas = ppp > 0 ? (Math.ceil(l.quantidade / ppp) * rpp) : '-'
          } else {
            const ppc = Number(c.pcs_por_caixa) || 0
            caixas = ppc > 0 ? Math.ceil(l.quantidade / ppc) : '-'
          }
          return {
            ferramenta: l.ferramenta,
            comprimento_mm: c.comprimento_mm || '-',
            quantidade: l.quantidade,
            embalagem,
            pallets, caixas, ripas,
            peso_estimado
          }
        })
        return (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Ferramenta</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Comprimento (mm)</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Qtd. PCS Apontadas</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Embalagem</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Estimativa Pallets</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Estimativa Caixas</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Estimativa Ripas</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Peso Estimado (kg)</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {linhas.map((r, idx) => (
                <tr key={idx}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{r.ferramenta}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{r.comprimento_mm}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{fmt(r.quantidade)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{r.embalagem}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{typeof r.pallets === 'number' ? fmt(r.pallets) : r.pallets}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{typeof r.caixas === 'number' ? fmt(r.caixas) : r.caixas}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{typeof r.ripas === 'number' ? fmt(r.ripas) : r.ripas}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{fmt(r.peso_estimado, 3)}</td>
                </tr>
              ))}
              {linhas.length === 0 && (
                <tr>
                  <td colSpan="8" className="px-6 py-6 text-center text-gray-500">Sem dados para estimativa</td>
                </tr>
              )}
            </tbody>
          </table>
        )
      }
      
      case 'produtividade': {
        // Agrupa por item (ferramenta + comprimento)
        const grupos = {}
        for (const a of apontamentosFiltrados) {
          const cod = (a.produto || a.codigoPerfil)
          const ferramenta = extrairFerramenta(cod)
          const comprimento = extrairComprimentoAcabado(cod)
          const key = `${ferramenta}__${comprimento}`
          if (!grupos[key]) grupos[key] = { ferramenta, comprimento, quantidade: 0, minutos: 0, porDia: {} }
          const q = Number(a.quantidade || 0)
          grupos[key].quantidade += isNaN(q) ? 0 : q
          const m = duracaoMin(a.inicio, a.fim)
          grupos[key].minutos += m || 0
          const dia = toISODate(a.inicio)
          if (dia) grupos[key].porDia[dia] = (grupos[key].porDia[dia] || 0) + (isNaN(q) ? 0 : q)
        }

        const linhas = Object.values(grupos).map(g => {
          const horas = (g.minutos || 0) / 60
          const media_h = horas > 0 ? g.quantidade / horas : 0
          const dias = Object.keys(g.porDia)
          const media_dia = dias.length > 0 ? (dias.reduce((acc,d)=> acc + (g.porDia[d]||0), 0) / dias.length) : 0
          const key = `${g.ferramenta}__${g.comprimento}`
          const ovr = overrides[key] || {}
          return { ...g, media_h, media_dia, key, ovr }
        }).sort((a,b)=> (a.ferramenta||'').localeCompare(b.ferramenta||''))

        return (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Ferramenta</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Comprimento</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Média (pcs/h)</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Ajuste (pcs/h)</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Média (pcs/dia)</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Ajuste (pcs/dia)</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {linhas.map((r, idx) => (
                <tr key={idx}>
                  <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-700">{r.ferramenta || '-'}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-700">{r.comprimento || '-'}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-700">{fmt(r.media_h, 2)}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-700">
                    <input
                      type="number"
                      className="input-field input-field-sm w-32"
                      placeholder="usar média"
                      value={r.ovr?.h ?? ''}
                      onChange={(e)=> setOverride(r.key, 'h', e.target.value)}
                    />
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-700">{fmt(r.media_dia, 0)}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-700">
                    <input
                      type="number"
                      className="input-field input-field-sm w-32"
                      placeholder="usar média"
                      value={r.ovr?.d ?? ''}
                      onChange={(e)=> setOverride(r.key, 'd', e.target.value)}
                    />
                  </td>
                </tr>
              ))}
              {linhas.length === 0 && (
                <tr>
                  <td colSpan="6" className="px-6 py-6 text-center text-gray-500">Sem dados para calcular produtividade</td>
                </tr>
              )}
            </tbody>
          </table>
        )
      }

      case 'apontamentos_rack': {
        const rows = buildRows('apontamentos_rack')
        return (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Rack!Embalagem</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Dias de Apontamentos</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Lotes</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Qtd Amarrados</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Produtos</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {(rows || []).map((r, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700 font-medium">{r['Rack!Embalagem'] || '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600 max-w-[240px] truncate" title={r['Dias de Apontamentos'] || ''}>{r['Dias de Apontamentos'] || '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600 max-w-[280px] truncate" title={r['Lotes'] || ''}>{r['Lotes'] || '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-800 font-semibold">{r['Qtd Amarrados'] ?? 0}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600 max-w-[320px] truncate" title={r['Produtos'] || ''}>{r['Produtos'] || '-'}</td>
                  </tr>
                ))}
                {(!rows || rows.length === 0) && (
                  <tr>
                    <td colSpan="5" className="px-6 py-6 text-center text-gray-500">Nenhum rack encontrado no período/seleção</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )
      }

      case 'rastreabilidade': {
        // Reutiliza a mesma lógica do export para montar linhas
        let linhas = (() => {
          const out = []
          for (const a of apontamentosOrdenados) {
            const base = {
              Data: brDate(a.inicio),
              Hora: brTime(a.inicio),
              Maquina: maqMap[String(a.maquina)] || a.maquina || '-',
              Operador: a.operador || '-',
              PedidoSeq: a.ordemTrabalho || a.ordem_trabalho || a.pedido_seq || '-',
              Produto_Usinagem: a.produto || a.codigoPerfil || '-',
              Lote_Usinagem: a.lote || '-',
              Qtde_Produzida: a.quantidade || 0,
              Qtde_Refugo: a.qtd_refugo || 0,
              RackOuPallet: a.rack_ou_pallet || a.rackOuPallet || '-',
              LotesExternos: Array.isArray(a.lotes_externos) ? a.lotes_externos.join(', ') : (a.lote_externo || '')
            }
            const arr = Array.isArray(a.amarrados_detalhados) ? a.amarrados_detalhados : []
            if (arr.length === 0) {
              // Fallback por lotes_externos quando não houver amarrados_detalhados
              const lotesExt = Array.isArray(a.lotes_externos) ? a.lotes_externos : (a.lote_externo ? [a.lote_externo] : [])
              if (lotesExt.length > 0) {
                for (const loteNum of lotesExt) {
                  const l = (lotesDB || []).find(x => String(x.lote || '').trim() === String(loteNum)) || {}
                  out.push({
                    ...base,
                    Amarrado_Codigo: String(l.codigo || '').trim(),
                    Amarrado_Lote: String(l.lote || '').trim(),
                    Amarrado_Rack: String(l.rack_embalagem || '').trim(),
                    Amarrado_Produto: String(l.produto || getCampoOriginalLote(l, 'Produto') || '').trim(),
                    Amarrado_PedidoSeq: String(l.pedido_seq || '').trim(),
                    Amarrado_Romaneio: String(l.romaneio || '').trim(),
                    Amarrado_QtKG: Number(l.qt_kg || 0) || '',
                    Amarrado_QtdPC: Number(l.qtd_pc || 0) || ''
                  })
                }
              } else {
                out.push(base)
              }
            } else {
              for (const am of arr) {
                out.push({
                  ...base,
                  Amarrado_Codigo: am.codigo || '',
                  Amarrado_Lote: am.lote || '',
                  Amarrado_Rack: am.rack || '',
                  Amarrado_Produto: am.produto || '',
                  Amarrado_PedidoSeq: am.pedido_seq || '',
                  Amarrado_Romaneio: am.romaneio || '',
                  Amarrado_QtKG: am.qt_kg ?? '',
                  Amarrado_QtdPC: am.qtd_pc ?? ''
                })
              }
            }
          }
          return out
        })()
        
        // Aplicar modo compacto se selecionado
        if (filtros.modo === 'compacto') {
          linhas = agruparRastreabilidadeCompacto(linhas)
        }

        return (
          <div className="overflow-x-auto">
            <table className="min-w-[1200px] divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Data</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Hora</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Máquina</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Operador</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Pedido/Seq</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Produto Usinagem</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Lote Usinagem</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Qtd Produzida</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Refugo</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Rack/Pallet</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Lotes Externos</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Amarrado Código</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Amarrado Lote</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Amarrado Rack</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Amarrado Produto</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Amarrado Pedido/Seq</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Amarrado Romaneio</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Amarrado Qt(kg)</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Amarrado Qtd(pc)</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {linhas.map((r, idx) => (
                  <tr key={idx}>
                    <td className="px-4 py-2 text-sm text-gray-700">{r.Data}</td>
                    <td className="px-4 py-2 text-sm text-gray-700">{r.Hora}</td>
                    <td className="px-4 py-2 text-sm text-gray-700">{r.Maquina}</td>
                    <td className="px-4 py-2 text-sm text-gray-700">{r.Operador}</td>
                    <td className="px-4 py-2 text-sm text-gray-700">{r.PedidoSeq}</td>
                    <td className="px-4 py-2 text-sm text-gray-700">{r.Produto_Usinagem}</td>
                    <td className="px-4 py-2 text-sm text-gray-700">{r.Lote_Usinagem}</td>
                    <td className="px-4 py-2 text-sm text-gray-700">{r.Qtde_Produzida}</td>
                    <td className="px-4 py-2 text-sm text-gray-700">{r.Qtde_Refugo}</td>
                    <td className="px-4 py-2 text-sm text-gray-700">{r.RackOuPallet}</td>
                    <td className="px-4 py-2 text-sm text-gray-700">{r.LotesExternos}</td>
                    <td className="px-4 py-2 text-sm text-gray-700">{r.Amarrado_Codigo || '-'}</td>
                    <td className="px-4 py-2 text-sm text-gray-700">{r.Amarrado_Lote || '-'}</td>
                    <td className="px-4 py-2 text-sm text-gray-700">{r.Amarrado_Rack || '-'}</td>
                    <td className="px-4 py-2 text-sm text-gray-700">{r.Amarrado_Produto || '-'}</td>
                    <td className="px-4 py-2 text-sm text-gray-700">{r.Amarrado_PedidoSeq || '-'}</td>
                    <td className="px-4 py-2 text-sm text-gray-700">{r.Amarrado_Romaneio || '-'}</td>
                    <td className="px-4 py-2 text-sm text-gray-700">{r.Amarrado_QtKG ?? '-'}</td>
                    <td className="px-4 py-2 text-sm text-gray-700">{r.Amarrado_QtdPC ?? '-'}</td>
                  </tr>
                ))}
                {linhas.length === 0 && (
                  <tr><td colSpan="19" className="px-6 py-6 text-center text-gray-500">Nenhum dado de rastreabilidade no período/seleção</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )
      }
      
      default:
        return <p>Selecione um tipo de relatório</p>
    }
  }
  
  // Indicadores e insights calculados
  const indicadores = useMemo(() => {
    const totalApontamentos = apontamentosFiltrados.length
    const totalProducao = apontamentosFiltrados.reduce((acc, a) => acc + (Number(a.quantidade) || 0), 0)
    const totalRefugo = apontamentosFiltrados.reduce((acc, a) => acc + (Number(a.qtd_refugo) || 0), 0)
    const taxaRefugo = totalProducao > 0 ? ((totalRefugo / totalProducao) * 100).toFixed(2) : 0
    
    // Tempo total trabalhado (em minutos)
    let tempoTotalMin = 0
    let apontamentosComTempo = 0
    for (const a of apontamentosFiltrados) {
      const d = duracaoMin(a.inicio, a.fim)
      if (d && d > 0) {
        tempoTotalMin += d
        apontamentosComTempo++
      }
    }
    const tempoTotalHoras = (tempoTotalMin / 60).toFixed(1)
    
    // Produtividade média (peças por hora)
    const produtividadeMedia = tempoTotalMin > 0 ? (totalProducao / (tempoTotalMin / 60)).toFixed(1) : 0
    
    // Operadores únicos
    const operadoresUnicos = new Set(apontamentosFiltrados.map(a => a.operador).filter(Boolean)).size
    
    // Máquinas únicas
    const maquinasUnicas = new Set(apontamentosFiltrados.map(a => a.maquina).filter(Boolean)).size
    
    // Apontamentos sem hora fim (pendentes)
    const semHoraFim = apontamentosFiltrados.filter(a => a.inicio && !a.fim).length
    
    // Insights automáticos
    const insights = []
    if (taxaRefugo > 5) {
      insights.push({ tipo: 'alerta', msg: `Taxa de refugo elevada: ${taxaRefugo}%`, icone: 'warning' })
    }
    if (semHoraFim > 0) {
      insights.push({ tipo: 'info', msg: `${semHoraFim} apontamento(s) sem hora de término`, icone: 'clock' })
    }
    if (produtividadeMedia > 0 && parseFloat(produtividadeMedia) < 10) {
      insights.push({ tipo: 'atencao', msg: `Produtividade abaixo de 10 pcs/h`, icone: 'chart' })
    }
    if (totalApontamentos > 0 && apontamentosComTempo === 0) {
      insights.push({ tipo: 'info', msg: 'Nenhum apontamento com duração calculada', icone: 'clock' })
    }
    if (totalProducao > 1000) {
      insights.push({ tipo: 'sucesso', msg: `Excelente! ${totalProducao.toLocaleString('pt-BR')} peças produzidas`, icone: 'check' })
    }
    
    return {
      totalApontamentos,
      totalProducao,
      totalRefugo,
      taxaRefugo,
      tempoTotalHoras,
      produtividadeMedia,
      operadoresUnicos,
      maquinasUnicas,
      semHoraFim,
      insights
    }
  }, [apontamentosFiltrados])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800">Relatórios</h1>
        <span className="text-sm text-gray-500">
          {filtros.dataInicio && `${new Date(filtros.dataInicio).toLocaleDateString('pt-BR')}`}
          {filtros.dataFim && ` até ${new Date(filtros.dataFim).toLocaleDateString('pt-BR')}`}
        </span>
      </div>

      {/* Cards de Indicadores Inteligentes */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-blue-500">
          <div className="flex items-center gap-2 text-gray-500 text-xs mb-1">
            <FaChartLine className="w-3 h-3" />
            <span>Apontamentos</span>
          </div>
          <div className="text-2xl font-bold text-gray-800">{indicadores.totalApontamentos}</div>
        </div>
        
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-green-500">
          <div className="flex items-center gap-2 text-gray-500 text-xs mb-1">
            <FaIndustry className="w-3 h-3" />
            <span>Produção Total</span>
          </div>
          <div className="text-2xl font-bold text-gray-800">{indicadores.totalProducao.toLocaleString('pt-BR')}</div>
          <div className="text-xs text-gray-400">peças</div>
        </div>
        
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-purple-500">
          <div className="flex items-center gap-2 text-gray-500 text-xs mb-1">
            <FaClock className="w-3 h-3" />
            <span>Tempo Total</span>
          </div>
          <div className="text-2xl font-bold text-gray-800">{indicadores.tempoTotalHoras}</div>
          <div className="text-xs text-gray-400">horas</div>
        </div>
        
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-teal-500">
          <div className="flex items-center gap-2 text-gray-500 text-xs mb-1">
            <FaTachometerAlt className="w-3 h-3" />
            <span>Produtividade</span>
          </div>
          <div className="text-2xl font-bold text-gray-800">{indicadores.produtividadeMedia}</div>
          <div className="text-xs text-gray-400">pcs/hora</div>
        </div>
        
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-orange-500">
          <div className="flex items-center gap-2 text-gray-500 text-xs mb-1">
            <FaUsers className="w-3 h-3" />
            <span>Operadores</span>
          </div>
          <div className="text-2xl font-bold text-gray-800">{indicadores.operadoresUnicos}</div>
        </div>
        
        <div className={`bg-white rounded-lg shadow p-4 border-l-4 ${parseFloat(indicadores.taxaRefugo) > 5 ? 'border-red-500' : 'border-gray-300'}`}>
          <div className="flex items-center gap-2 text-gray-500 text-xs mb-1">
            <FaExclamationTriangle className="w-3 h-3" />
            <span>Taxa Refugo</span>
          </div>
          <div className={`text-2xl font-bold ${parseFloat(indicadores.taxaRefugo) > 5 ? 'text-red-600' : 'text-gray-800'}`}>
            {indicadores.taxaRefugo}%
          </div>
          <div className="text-xs text-gray-400">{indicadores.totalRefugo} pcs</div>
        </div>
      </div>

      {/* Insights e Alertas Automáticos */}
      {indicadores.insights.length > 0 && (
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-4 border border-blue-100">
          <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
            <FaChartLine className="w-4 h-4 text-blue-600" />
            Insights Automáticos
          </h3>
          <div className="flex flex-wrap gap-2">
            {indicadores.insights.map((insight, idx) => (
              <div 
                key={idx}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${
                  insight.tipo === 'alerta' ? 'bg-red-100 text-red-700' :
                  insight.tipo === 'atencao' ? 'bg-yellow-100 text-yellow-700' :
                  insight.tipo === 'sucesso' ? 'bg-green-100 text-green-700' :
                  'bg-blue-100 text-blue-700'
                }`}
              >
                {insight.icone === 'warning' && <FaExclamationTriangle className="w-3 h-3" />}
                {insight.icone === 'clock' && <FaClock className="w-3 h-3" />}
                {insight.icone === 'chart' && <FaChartLine className="w-3 h-3" />}
                {insight.icone === 'check' && <FaCheckCircle className="w-3 h-3" />}
                {insight.msg}
              </div>
            ))}
          </div>
        </div>
      )}
      
      <div className="bg-white rounded-lg shadow p-4 md:p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-700">Filtros</h2>
          <button
            type="button"
            onClick={() => setFiltrosAberto(v => !v)}
            className="text-sm text-blue-600 hover:text-blue-700 hover:underline"
            title={filtrosAberto ? 'Recolher filtros' : 'Expandir filtros'}
          >
            {filtrosAberto ? 'Recolher' : 'Expandir'}
          </button>
        </div>
        
        {filtrosAberto && (
        <form onSubmit={handleSubmit} className="mt-2">
          {/* Grid responsivo para filtros principais */}
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tipo de Relatório
              </label>
              <select
                name="tipoRelatorio"
                value={filtros.tipoRelatorio}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm bg-gray-50"
              >
                {tiposRelatorio.map(tipo => (
                  <option key={tipo.id} value={tipo.id}>{tipo.nome}</option>
                ))}
              </select>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Data Início
              </label>
              <input
                type="date"
                name="dataInicio"
                value={filtros.dataInicio}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Data Fim
              </label>
              <input
                type="date"
                name="dataFim"
                value={filtros.dataFim}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Máquina
              </label>
              <select
                name="maquina"
                value={filtros.maquina}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              >
                <option value="">Todas as máquinas</option>
                {maquinasLista.map(maq => (
                  <option key={maq.id || maq.nome} value={maq.nome}>{maq.nome}</option>
                ))}
              </select>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Operador
              </label>
              <select
                name="operador"
                value={filtros.operador}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              >
                <option value="">Todos os operadores</option>
                {operadores.map(op => (
                  <option key={op.id} value={op.nome}>{op.nome}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Cliente
              </label>
              <input
                type="text"
                name="cliente"
                value={filtros.cliente}
                onChange={handleChange}
                placeholder="Filtrar por cliente"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Produto
              </label>
              <input
                type="text"
                name="produto"
                value={filtros.produto}
                onChange={handleChange}
                placeholder="Filtrar por produto"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Rack
              </label>
              <input
                type="text"
                name="rack"
                value={filtros.rack}
                onChange={handleChange}
                placeholder="Filtrar por rack/pallet"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Pedido Cliente
              </label>
              <input
                type="text"
                name="pedidoCliente"
                value={filtros.pedidoCliente}
                onChange={handleChange}
                placeholder="Filtrar por pedido cliente"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Ferramenta
              </label>
              <input
                list="ferramentas-relatorios"
                name="ferramenta"
                value={filtros.ferramenta}
                onChange={handleChange}
                placeholder="Digite ou selecione a ferramenta"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
              <datalist id="ferramentas-relatorios">
                {ferramentasLista.map(f => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Comprimento
              </label>
              <input
                list="comprimentos-relatorios"
                name="comprimento"
                value={filtros.comprimento}
                onChange={handleChange}
                placeholder={filtros.ferramenta ? 'Digite ou selecione o comprimento' : 'Selecione antes uma ferramenta'}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                disabled={!filtros.ferramenta && comprimentosLista.length > 20}
              />
              <datalist id="comprimentos-relatorios">
                {comprimentosLista.map(c => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
            
            {/* Modo de Exibição (apenas para rastreabilidade) */}
            {tipoBaseRelatorio(filtros.tipoRelatorio) === 'rastreabilidade' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Modo de Exibição
                </label>
                <select
                  name="modo"
                  value={filtros.modo}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm bg-gray-50"
                >
                  <option value="detalhado">Detalhado (1 linha por amarrado)</option>
                  <option value="compacto">Compacto (amarrados concatenados)</option>
                </select>
              </div>
            )}
          </div>
          
          {/* Seção de formato e botão */}
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 pt-4 border-t border-gray-100">
            <div className="sm:w-48">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Formato de Exportação
              </label>
              <select
                name="formato"
                value={filtros.formato}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm bg-gray-50"
              >
                <option value="excel">Excel</option>
                <option value="pdf">PDF</option>
              </select>
            </div>
            
            <div className="flex gap-3">
              <button 
                type="submit" 
                className="px-6 py-2 bg-blue-600 text-white font-medium rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors whitespace-nowrap shadow-sm"
              >
                Gerar Relatório
              </button>
              <button 
                type="button"
                onClick={handleGerarTodosRelatorios}
                className="px-6 py-2 bg-green-600 text-white font-medium rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 transition-colors whitespace-nowrap shadow-sm"
              >
                Gerar Todos
              </button>
            </div>
          </div>
        </form>
        )}
      </div>
      
      <div className="bg-white rounded-lg shadow p-4 md:p-6">
        <h2 className="text-lg font-semibold text-gray-700 mb-4">Visualização Prévia</h2>
        
        <div className="overflow-x-auto pb-4">
          <PreviewRelatorio tipo={filtros.tipoRelatorio} />
        </div>
      </div>

      {/* Modal de Impressão */}
      <PrintModal
        isOpen={printModalAberto}
        onClose={() => {
          setPrintModalAberto(false)
          setApontamentoSelecionado(null)
        }}
        apontamento={apontamentoSelecionado}
        onPrintSuccess={(apontamento) => {
          console.log('Impressão realizada com sucesso para:', apontamento)
        }}
      />
    </div>
  )
}

export default Relatorios
