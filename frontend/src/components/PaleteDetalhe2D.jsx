import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from '../config/supabase'
import { calcularDimensoesPalete } from './PaleteVisualizacao3D'

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt = (n, dec = 0) => Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: dec, minimumFractionDigits: dec })
const fmtMm = (mm) => mm >= 1000 ? `${fmt(mm / 1000, 3)} m` : `${fmt(mm)} mm`

// ─── Diagrama 2D lateral (vista de frente: X=largura, Y=altura) ───────────────
function DiagramaLateral({ config, completude, pcsPorAmarrado, pcsPorPalete, pecasReais }) {
  const { pacotes_por_camada, camadas_por_bloco, num_blocos, largura_pacote_mm, altura_pacote_mm,
    ripa_altura_mm, ripa_entre_camadas, ripa_topo, ripa_vert_comp_mm, ripa_vertical } = config

  const totalCamadas = (camadas_por_bloco || 3) * (num_blocos || 3)
  const totalPacotes = (pacotes_por_camada || 3) * totalCamadas
  const pkH = altura_pacote_mm || 100
  const ripaH = ripa_entre_camadas ? (ripa_altura_mm || 17) : 0
  const ripaVertW = ripa_vertical ? (ripa_vert_comp_mm || 75) : 0
  const pkW = largura_pacote_mm || 300

  // Calcular completude real: amarrados no rack / amarrados esperados no palete
  const amarradosReais = pcsPorAmarrado > 0 ? Math.floor((pecasReais || 0) / pcsPorAmarrado) : 0
  const amarradosPalete = pcsPorAmarrado > 0 && pcsPorPalete > 0 ? Math.floor(pcsPorPalete / pcsPorAmarrado) : 0
  // pct baseado em amarrados (mesma lógica da barra de progresso e do badge da lista)
  const pct = amarradosPalete > 0 ? Math.min(1, amarradosReais / amarradosPalete) : (completude || 0)

  // Dimensões do SVG
  const SVG_W = 520
  const SVG_H = 320
  const MARGIN = { top: 24, left: 40, right: 20, bottom: 32 }
  const drawW = SVG_W - MARGIN.left - MARGIN.right
  const drawH = SVG_H - MARGIN.top - MARGIN.bottom

  // Dimensões canônicas (fonte única de verdade, igual à aba 3D)
  const dimsCanonicos = calcularDimensoesPalete(config)
  const labelLargMm = dimsCanonicos?.larguraMm || 0
  const labelAltMm  = dimsCanonicos?.alturaMm || 0

  // Dimensões visuais do SVG (inclui ripas laterais para o desenho)
  const totalLargMm = ripaVertW * 2 + pkW * (pacotes_por_camada || 1)
  const scaleX = drawW / totalLargMm

  // Altura visual do SVG (simplificada para o desenho)
  const altBloco = pkH + (ripa_entre_camadas ? ripaH : 0)
  const altTotal = 112 + (camadas_por_bloco || 3) * (num_blocos || 3) * altBloco + (ripa_topo ? ripaH : 0)
  const scaleY = drawH / altTotal

  const baseH = 112 * scaleY
  const pkHpx = pkH * scaleY
  const ripaHpx = ripaH * scaleY
  const pkWpx = pkW * scaleX
  const ripaVertWpx = ripaVertW * scaleX

  // Contar quantos pacotes são "reais"
  const pacotesConfirmados = Math.round(pct * totalPacotes)

  const camadas = []
  let yAtual = MARGIN.top + drawH - baseH // começa do topo do palete base
  let pacotesContados = 0

  for (let b = 0; b < (num_blocos || 3); b++) {
    for (let c = 0; c < (camadas_por_bloco || 3); c++) {
      yAtual -= pkHpx

      for (let p = 0; p < (pacotes_por_camada || 3); p++) {
        const x = MARGIN.left + ripaVertWpx + p * pkWpx
        pacotesContados++
        const cheio = pacotesContados <= pacotesConfirmados
        camadas.push(
          <rect
            key={`p-${b}-${c}-${p}`}
            x={x} y={yAtual}
            width={pkWpx - 1} height={pkHpx - 1}
            fill={cheio ? '#4ade80' : '#e5e7eb'}
            stroke={cheio ? '#16a34a' : '#d1d5db'}
            strokeWidth={0.8}
            rx={2}
          />
        )
        if (cheio && p === 0 && c === 0 && b === 0) {
          // label apenas no primeiro
        }
      }

      // Ripa entre camadas
      if ((ripa_entre_camadas && ripaH > 0) && (c < (camadas_por_bloco || 3) - 1 || b < (num_blocos || 3) - 1)) {
        yAtual -= ripaHpx
        camadas.push(
          <rect
            key={`ripa-${b}-${c}`}
            x={MARGIN.left + ripaVertWpx} y={yAtual}
            width={drawW - ripaVertWpx * 2} height={ripaHpx}
            fill="#d97706" opacity={0.7} rx={1}
          />
        )
      }
    }
    if (b < (num_blocos || 3) - 1 && ripa_entre_camadas && ripaH > 0) {
      yAtual -= ripaHpx
      camadas.push(
        <rect key={`ripa-bloco-${b}`}
          x={MARGIN.left + ripaVertWpx} y={yAtual}
          width={drawW - ripaVertWpx * 2} height={ripaHpx}
          fill="#b45309" opacity={0.85} rx={1}
        />
      )
    }
  }

  // Ripa topo
  if (ripa_topo && ripaH > 0) {
    yAtual -= ripaHpx
    camadas.push(
      <rect key="ripa-topo"
        x={MARGIN.left + ripaVertWpx} y={yAtual}
        width={drawW - ripaVertWpx * 2} height={ripaHpx}
        fill="#d97706" opacity={0.7} rx={1}
      />
    )
  }

  // Ripas laterais verticais
  const altEmpilhMm = altTotal - 112
  const ripaVertAlturaPx = altEmpilhMm * scaleY
  const ripaVertY = MARGIN.top + drawH - baseH - ripaVertAlturaPx

  return (
    <svg width={SVG_W} height={SVG_H} style={{ width: '100%', height: 'auto' }}>
      {/* Fundo */}
      <rect x={0} y={0} width={SVG_W} height={SVG_H} fill="#f8fafc" rx={8} />

      {/* Ripas laterais */}
      {ripa_vertical && ripaVertWpx > 0 && (
        <>
          <rect x={MARGIN.left} y={ripaVertY} width={ripaVertWpx} height={ripaVertAlturaPx}
            fill="#78350f" opacity={0.6} rx={2} />
          <rect x={MARGIN.left + drawW - ripaVertWpx} y={ripaVertY} width={ripaVertWpx} height={ripaVertAlturaPx}
            fill="#78350f" opacity={0.6} rx={2} />
        </>
      )}

      {/* Pacotes e ripas */}
      {camadas}

      {/* Base do palete */}
      <rect x={MARGIN.left} y={MARGIN.top + drawH - baseH}
        width={drawW} height={baseH}
        fill="#fde68a" stroke="#f59e0b" strokeWidth={1} rx={2} />
      <text x={MARGIN.left + drawW / 2} y={MARGIN.top + drawH - baseH / 2 + 4}
        textAnchor="middle" fontSize={9} fill="#92400e" fontWeight="600">
        Palete PBR 112mm
      </text>

      {/* Cotas: Largura */}
      <line x1={MARGIN.left} y1={MARGIN.top + drawH + 12} x2={MARGIN.left + drawW} y2={MARGIN.top + drawH + 12}
        stroke="#6b7280" strokeWidth={1} />
      <line x1={MARGIN.left} y1={MARGIN.top + drawH + 8} x2={MARGIN.left} y2={MARGIN.top + drawH + 16} stroke="#6b7280" strokeWidth={1} />
      <line x1={MARGIN.left + drawW} y1={MARGIN.top + drawH + 8} x2={MARGIN.left + drawW} y2={MARGIN.top + drawH + 16} stroke="#6b7280" strokeWidth={1} />
      <text x={MARGIN.left + drawW / 2} y={MARGIN.top + drawH + 24}
        textAnchor="middle" fontSize={9} fill="#374151">
        {fmtMm(labelLargMm || totalLargMm)} (largura)
      </text>

      {/* Cotas: Altura */}
      <line x1={MARGIN.left - 14} y1={MARGIN.top} x2={MARGIN.left - 14} y2={MARGIN.top + drawH}
        stroke="#6b7280" strokeWidth={1} />
      <line x1={MARGIN.left - 18} y1={MARGIN.top} x2={MARGIN.left - 10} y2={MARGIN.top} stroke="#6b7280" strokeWidth={1} />
      <line x1={MARGIN.left - 18} y1={MARGIN.top + drawH} x2={MARGIN.left - 10} y2={MARGIN.top + drawH} stroke="#6b7280" strokeWidth={1} />
      <text x={MARGIN.left - 20} y={MARGIN.top + drawH / 2}
        textAnchor="middle" fontSize={9} fill="#374151"
        transform={`rotate(-90, ${MARGIN.left - 20}, ${MARGIN.top + drawH / 2})`}>
        {fmtMm(labelAltMm || altTotal)} (alt.)
      </text>

      {/* Badge de completude */}
      <rect x={SVG_W - 80} y={4} width={74} height={20} rx={10}
        fill={pct >= 0.99 ? '#16a34a' : pct >= 0.5 ? '#f59e0b' : '#ef4444'} />
      <text x={SVG_W - 43} y={17} textAnchor="middle" fontSize={10} fill="white" fontWeight="700">
        {Math.round(pct * 100)}% completo
      </text>
    </svg>
  )
}

// ─── Vista Superior 2D (planta) ───────────────────────────────────────────────
function DiagramaPlanta({ config }) {
  const { pacotes_por_camada, largura_pacote_mm, profundidade_pacote_mm,
    ripa_vert_comp_mm, ripa_vertical, orientacao_pacote } = config

  const pkW = largura_pacote_mm || 300
  const pkD = profundidade_pacote_mm || 6000
  const ripaW = ripa_vertical ? (ripa_vert_comp_mm || 75) : 0
  const nCols = pacotes_por_camada || 3

  const SVG_W = 520
  const SVG_H = 180
  const MARGIN = { top: 20, left: 40, right: 20, bottom: 28 }
  const drawW = SVG_W - MARGIN.left - MARGIN.right
  const drawH = SVG_H - MARGIN.top - MARGIN.bottom

  const totalLarg = ripaW * 2 + pkW * nCols
  const totalProf = pkD

  const scaleX = drawW / totalLarg
  const scaleY = drawH / totalProf

  const ripaWpx = ripaW * scaleX
  const pkWpx = pkW * scaleX
  const pkDpx = pkD * scaleY

  const cores = ['#bfdbfe', '#bbf7d0', '#fde68a', '#fecaca', '#e9d5ff', '#fed7aa']

  return (
    <svg width={SVG_W} height={SVG_H} style={{ width: '100%', height: 'auto' }}>
      <rect x={0} y={0} width={SVG_W} height={SVG_H} fill="#f8fafc" rx={8} />

      {/* Ripas laterais (vista de cima = faixas nas laterais) */}
      {ripa_vertical && ripaWpx > 0 && (
        <>
          <rect x={MARGIN.left} y={MARGIN.top} width={ripaWpx} height={pkDpx}
            fill="#d97706" opacity={0.5} rx={1} />
          <rect x={MARGIN.left + drawW - ripaWpx} y={MARGIN.top} width={ripaWpx} height={pkDpx}
            fill="#d97706" opacity={0.5} rx={1} />
        </>
      )}

      {/* Pacotes (vista superior) */}
      {Array.from({ length: nCols }).map((_, i) => (
        <rect
          key={i}
          x={MARGIN.left + ripaWpx + i * pkWpx} y={MARGIN.top}
          width={pkWpx - 1} height={pkDpx}
          fill={cores[i % cores.length]}
          stroke="#94a3b8" strokeWidth={0.8}
          rx={2}
        />
      ))}

      {/* Labels das colunas */}
      {Array.from({ length: nCols }).map((_, i) => (
        <text key={i}
          x={MARGIN.left + ripaWpx + (i + 0.5) * pkWpx}
          y={MARGIN.top + pkDpx / 2}
          textAnchor="middle" fontSize={9} fill="#1e40af" fontWeight="600">
          Col.{i + 1}
        </text>
      ))}

      {/* Cota largura */}
      <line x1={MARGIN.left} y1={MARGIN.top + pkDpx + 10} x2={MARGIN.left + drawW} y2={MARGIN.top + pkDpx + 10}
        stroke="#6b7280" strokeWidth={1} />
      <line x1={MARGIN.left} y1={MARGIN.top + pkDpx + 6} x2={MARGIN.left} y2={MARGIN.top + pkDpx + 14} stroke="#6b7280" strokeWidth={1} />
      <line x1={MARGIN.left + drawW} y1={MARGIN.top + pkDpx + 6} x2={MARGIN.left + drawW} y2={MARGIN.top + pkDpx + 14} stroke="#6b7280" strokeWidth={1} />
      <text x={MARGIN.left + drawW / 2} y={MARGIN.top + pkDpx + 22}
        textAnchor="middle" fontSize={9} fill="#374151">
        {fmtMm(totalLarg)} (X)
      </text>

      {/* Cota profundidade */}
      <line x1={MARGIN.left - 14} y1={MARGIN.top} x2={MARGIN.left - 14} y2={MARGIN.top + pkDpx}
        stroke="#6b7280" strokeWidth={1} />
      <line x1={MARGIN.left - 18} y1={MARGIN.top} x2={MARGIN.left - 10} y2={MARGIN.top} stroke="#6b7280" strokeWidth={1} />
      <line x1={MARGIN.left - 18} y1={MARGIN.top + pkDpx} x2={MARGIN.left - 10} y2={MARGIN.top + pkDpx} stroke="#6b7280" strokeWidth={1} />
      <text x={MARGIN.left - 20} y={MARGIN.top + pkDpx / 2}
        textAnchor="middle" fontSize={9} fill="#374151"
        transform={`rotate(-90, ${MARGIN.left - 20}, ${MARGIN.top + pkDpx / 2})`}>
        {fmtMm(totalProf)} (Z)
      </text>
    </svg>
  )
}

// ─── COMPONENTE PRINCIPAL ─────────────────────────────────────────────────────
export default function PaleteDetalhe2D({ ferramenta, comprimento, config, ferramentaCfg }) {
  const [secaoLateralAberta, setSecaoLateralAberta] = useState(true)
  const [secaoPlantaAberta, setSecaoPlantaAberta] = useState(false)
  const [secaoDimsAberta, setSecaoDimsAberta] = useState(false)
  const [secaoEstruturaAberta, setSecaoEstruturaAberta] = useState(false)
  const [secaoApontamentoAberto, setSecaoApontamentoAberto] = useState(false)
  const [racks, setRacks] = useState([])
  const [loading, setLoading] = useState(false)
  const [rackSelecionado, setRackSelecionado] = useState(null)
  const [apontamentoRack, setApontamentoRack] = useState(null)

  // Filtros do painel esquerdo
  const [buscaRack, setBuscaRack] = useState('')
  const [filtroCliente, setFiltroCliente] = useState('')
  const [filtroRomaneio, setFiltroRomaneio] = useState('')
  const [modoFiltro, setModoFiltro] = useState('todos') // 'todos' | 'comRomaneio' | 'semRomaneio'
  const [romaneirosAtivos, setRomaneirosAtivos] = useState([]) // lista de numero_romaneio válidos e ativos

  const SELECT = 'rack_acabado, rack_ou_pallet, produto, quantidade, cliente, pedido_seq, comprimento_acabado_mm, rack_finalizado, romaneio_numero'

  // ── Busca principal: todos os romaneios ativos (sem filtro de ferramenta) + racks da ferramenta ──
  const buscarRacks = useCallback(async () => {
    setLoading(true)
    try {
      // 1. Buscar romaneios ativos da tabela oficial (status não cancelado/expedido)
      const { data: romData } = await supabase
        .from('expedicao_romaneios')
        .select('numero_romaneio, status, cliente')
        .in('status', ['pendente', 'em_separacao', 'separado', 'conferido', 'conferido_divergencia'])
        .order('data_criacao', { ascending: false })
        .limit(500)

      const numerosAtivos = new Set((romData || []).map(r => String(r.numero_romaneio || '').trim()).filter(Boolean))
      setRomaneirosAtivos((romData || []).map(r => ({ numero: String(r.numero_romaneio || '').trim(), cliente: r.cliente, status: r.status })).filter(r => r.numero))

      const queries = [
        // Sempre: apontamentos vinculados a romaneios ativos (sem filtro de ferramenta)
        supabase.from('apontamentos').select(SELECT)
          .not('romaneio_numero', 'is', null).neq('romaneio_numero', '').limit(2000),
      ]

      // Se ferramenta selecionada: adiciona racks da ferramenta (com ou sem romaneio)
      if (ferramenta) {
        const ferrNorm = ferramenta.replace(/-/g, '')
        queries.push(
          supabase.from('apontamentos').select(SELECT)
            .ilike('produto', `${ferrNorm}%`)
            .not('rack_acabado', 'is', null).neq('rack_acabado', '').limit(500),
          supabase.from('apontamentos').select(SELECT)
            .ilike('produto', `${ferrNorm}%`)
            .is('rack_acabado', null)
            .not('rack_ou_pallet', 'is', null).neq('rack_ou_pallet', '').limit(300),
        )
      }

      const resultados = await Promise.all(queries)
      const compNum = comprimento ? parseInt(comprimento, 10) : null

      // Deduplicar e agrupar por rack
      const visto = new Set()
      const porRack = {}

      resultados.forEach((res, idx) => {
        if (res.error) { console.warn('Query erro:', res.error); return }
        const isSoRomaneio = idx === 0 // primeira query = somente romaneios, sem filtro de ferramenta
        ;(res.data || []).forEach(a => {
          const rack = String(a.rack_acabado || a.rack_ou_pallet || '').trim().toUpperCase()
          if (!rack) return

          // Query exclusiva de romaneios (idx=0): descartar se não está nos ativos
          if (isSoRomaneio) {
            const numRom = String(a.romaneio_numero || '').trim()
            if (!numerosAtivos.has(numRom)) return
          }

          // Deduplicar linha exata
          const key = `${rack}|${a.produto}|${a.quantidade}`
          if (visto.has(key)) return
          visto.add(key)

          // Filtro de comprimento tolerante (só aplica para racks da ferramenta, não para romaneios)
          if (!isSoRomaneio && compNum) {
            const compApt = Number(a.comprimento_acabado_mm || 0)
            if (compApt > 0 && compApt !== compNum) return
          }

          // Validar romaneio_numero: se preenchido mas não é um romaneio ativo, tratar como nulo
          const romaneioValido = a.romaneio_numero && numerosAtivos.has(String(a.romaneio_numero).trim())
            ? String(a.romaneio_numero).trim()
            : null

          if (!porRack[rack]) {
            porRack[rack] = {
              rack,
              produto: a.produto,
              cliente: a.cliente,
              pedido_seq: a.pedido_seq,
              comprimento_acabado_mm: a.comprimento_acabado_mm,
              rack_finalizado: a.rack_finalizado,
              romaneio_numero: romaneioValido,
              _deFerramenta: !isSoRomaneio,
              quantidade: 0,
            }
          }
          // Atualizar romaneio apenas se o rack ainda não tem um válido
          if (romaneioValido && !porRack[rack].romaneio_numero) {
            porRack[rack].romaneio_numero = romaneioValido
          }
          if (!isSoRomaneio) porRack[rack]._deFerramenta = true
          porRack[rack].quantidade += Number(a.quantidade || 0)
        })
      })

      setRacks(Object.values(porRack).sort((a, b) => a.rack.localeCompare(b.rack)))
    } catch (e) {
      console.error('Erro ao buscar racks:', e)
    } finally {
      setLoading(false)
    }
  }, [ferramenta, comprimento])

  useEffect(() => { buscarRacks() }, [buscarRacks])

  // Ao selecionar um rack, buscar detalhes do apontamento
  const selecionarRack = useCallback(async (item) => {
    setRackSelecionado(item)
    try {
      const { data } = await supabase.from('apontamentos').select('*')
        .or(`rack_acabado.eq.${item.rack},rack_ou_pallet.eq.${item.rack}`)
        .order('created_at', { ascending: false })
        .limit(1).maybeSingle()
      setApontamentoRack(data)
    } catch (e) { setApontamentoRack(null) }
  }, [])

  // ── Listas de opções para os selects ──
  const clientesUnicos = useMemo(() =>
    [...new Set(racks.map(r => r.cliente).filter(Boolean))].sort()
  , [racks])

  // Só exibir no dropdown romaneios que realmente têm racks carregados
  const racksRomaneiosSet = useMemo(() => new Set(racks.map(r => r.romaneio_numero).filter(Boolean)), [racks])

  const romaneirosUnicos = useMemo(() =>
    romaneirosAtivos
      .filter(r => racksRomaneiosSet.has(r.numero))
      .map(r => r.numero)
      .sort()
  , [romaneirosAtivos, racksRomaneiosSet])

  // ── Aplicar filtros ──
  const racksFiltrados = useMemo(() => {
    let lista = racks

    // Quando há filtro de romaneio específico, ignorar modo e mostrar todos do romaneio
    if (filtroRomaneio) {
      lista = lista.filter(r => String(r.romaneio_numero || '') === filtroRomaneio)
    } else {
      // Modo de exibição
      if (modoFiltro === 'comRomaneio') {
        lista = lista.filter(r => r.romaneio_numero)
      } else if (modoFiltro === 'semRomaneio') {
        lista = lista.filter(r => !r.romaneio_numero && r._deFerramenta)
      } else {
        // 'todos': mostrar da ferramenta + com romaneio; ocultar os que só vieram da query de romaneio sem ser da ferramenta
        if (ferramenta) lista = lista.filter(r => r._deFerramenta || r.romaneio_numero)
      }
    }

    // Filtro por cliente
    if (filtroCliente) {
      lista = lista.filter(r => String(r.cliente || '').toUpperCase() === filtroCliente.toUpperCase())
    }

    // Busca por rack
    if (buscaRack.trim()) {
      const t = buscaRack.trim().toUpperCase()
      lista = lista.filter(r =>
        r.rack.includes(t) ||
        String(r.produto || '').toUpperCase().includes(t) ||
        String(r.cliente || '').toUpperCase().includes(t)
      )
    }

    return lista
  }, [racks, modoFiltro, filtroCliente, filtroRomaneio, buscaRack, ferramenta])

  const pcsPorAmarrado = Number(ferramentaCfg?.pecas_por_amarrado || 0)
  const pcsPorPalete   = Number(ferramentaCfg?.embalagem === 'caixa' ? ferramentaCfg?.pcs_por_caixa : ferramentaCfg?.pcs_por_pallet) || 0
  const totalPacotesPalete = config
    ? (config.pacotes_por_camada || 3) * (config.camadas_por_bloco || 3) * (config.num_blocos || 3)
    : 0

  // Informações do rack selecionado
  const pecasRack = rackSelecionado?.quantidade || 0
  const amarradosRack = pcsPorAmarrado > 0 ? Math.floor(pecasRack / pcsPorAmarrado) : 0
  const sobraPecas = pcsPorAmarrado > 0 ? (pecasRack % pcsPorAmarrado) : 0
  const amarradosPalete = pcsPorAmarrado > 0 && pcsPorPalete > 0 ? Math.floor(pcsPorPalete / pcsPorAmarrado) : 0
  const pct = amarradosPalete > 0 ? Math.min(1, amarradosRack / amarradosPalete) : 0
  const completo = pct >= 0.99

  // Dimensões calculadas do palete (fonte única de verdade, consistente com aba 3D)
  const dimsCalc = calcularDimensoesPalete(config)
  const totalLargMm = dimsCalc?.larguraMm || 0
  const totalProfMm = dimsCalc?.comprimentoMm || 0
  const totalAltMm  = dimsCalc?.alturaMm || 0
  const nCols = config?.pacotes_por_camada || 1
  const pkLarg = config?.largura_pacote_mm || 0
  const pkProf = config?.profundidade_pacote_mm || 0

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-gray-50">

      {/* ── Painel esquerdo: filtros + lista de racks ── */}
      <div className="w-72 flex-shrink-0 flex flex-col border-r border-gray-200 bg-white overflow-hidden">

        {/* Cabeçalho com título e botão recarregar */}
        <div className="px-3 pt-2 pb-1 border-b border-gray-100 bg-gray-50 flex items-center justify-between flex-shrink-0">
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Paletes</p>
          <button onClick={buscarRacks} disabled={loading}
            className="text-[10px] text-gray-400 hover:text-amber-600 transition-colors"
            title="Recarregar">
            {loading ? '⟳' : '↺ Recarregar'}
          </button>
        </div>

        {/* Filtros */}
        <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 flex-shrink-0 space-y-2">

          {/* Modo de exibição */}
          <div className="flex gap-1">
            {[
              { id: 'todos', label: 'Todos' },
              { id: 'comRomaneio', label: '📋 Em Romaneio' },
              { id: 'semRomaneio', label: 'Sem Romaneio' },
            ].map(m => (
              <button key={m.id} onClick={() => setModoFiltro(m.id)}
                className={`flex-1 text-[9px] font-bold py-1 rounded border transition-colors ${
                  modoFiltro === m.id
                    ? 'bg-amber-500 border-amber-500 text-white'
                    : 'bg-white border-gray-200 text-gray-500 hover:border-amber-300'
                }`}>
                {m.label}
              </button>
            ))}
          </div>

          {/* Filtro por Cliente */}
          <div>
            <label className="text-[9px] font-bold text-gray-400 uppercase block mb-0.5">Cliente</label>
            <select
              value={filtroCliente}
              onChange={e => setFiltroCliente(e.target.value)}
              className="w-full text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:border-amber-400 bg-white"
            >
              <option value="">Todos os clientes</option>
              {clientesUnicos.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          {/* Filtro por Romaneio */}
          <div>
            <label className="text-[9px] font-bold text-gray-400 uppercase block mb-0.5">Romaneio</label>
            <select
              value={filtroRomaneio}
              onChange={e => setFiltroRomaneio(e.target.value)}
              className="w-full text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:border-amber-400 bg-white"
            >
              <option value="">Todos os romaneios</option>
              {romaneirosUnicos.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>

          {/* Busca por rack */}
          <div>
            <label className="text-[9px] font-bold text-gray-400 uppercase block mb-0.5">Buscar Rack / Produto</label>
            <input type="text" value={buscaRack} onChange={e => setBuscaRack(e.target.value)}
              placeholder="Ex: USI-1747, EXP908..."
              className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:border-amber-400"
            />
          </div>

          {/* Contador */}
          <p className="text-[10px] text-gray-400">
            {loading ? 'Carregando...' : `${racksFiltrados.length} palete(s) encontrado(s)`}
          </p>
        </div>

        {/* Lista de racks */}
        <div className="flex-1 overflow-y-auto">
          {racksFiltrados.map(item => {
            const pcs = item.quantidade
            const ams = pcsPorAmarrado > 0 ? Math.floor(pcs / pcsPorAmarrado) : 0
            const p = amarradosPalete > 0 ? Math.min(1, ams / amarradosPalete) : 0
            const selected = rackSelecionado?.rack === item.rack
            return (
              <button key={item.rack} onClick={() => selecionarRack(item)}
                className={`w-full text-left px-3 py-2.5 border-b border-gray-100 hover:bg-amber-50 transition-colors ${
                  selected ? 'bg-amber-100 border-l-4 border-l-amber-500' : ''
                }`}>
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-xs font-bold text-gray-800 font-mono">{item.rack}</span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                    p >= 0.99 ? 'bg-green-100 text-green-700' : p >= 0.5 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-600'
                  }`}>
                    {Math.round(p * 100)}%
                  </span>
                </div>
                <div className="text-[10px] text-gray-500 truncate">{item.cliente}</div>
                <div className="text-[10px] text-gray-400">
                  {fmt(pcs)} pcs{pcsPorAmarrado > 0 ? ` · ${fmt(ams)} amar.` : ''}
                </div>
                {item.romaneio_numero && (
                  <div className="text-[10px] text-blue-600 font-semibold truncate">📋 {item.romaneio_numero}</div>
                )}
              </button>
            )
          })}
          {!loading && racksFiltrados.length === 0 && (
            <div className="p-4 text-center text-xs text-gray-400">Nenhum palete encontrado</div>
          )}
        </div>
      </div>

      {/* ── Painel direito: detalhes do rack selecionado ── */}
      <div className="flex-1 overflow-y-auto min-w-0">
        {!rackSelecionado ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2">
            <svg className="w-12 h-12 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
            <p className="text-sm">Selecione um palete para visualizar os detalhes</p>
          </div>
        ) : (
          <div className="p-3 space-y-2">

            {/* Header compacto */}
            <div className={`rounded-lg px-3 py-2 border flex items-center justify-between gap-2 ${completo ? 'bg-green-50 border-green-300' : 'bg-yellow-50 border-yellow-300'}`}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-sm font-black font-mono text-gray-800">{rackSelecionado.rack}</span>
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${completo ? 'bg-green-500 text-white' : 'bg-yellow-500 text-white'}`}>
                    {completo ? '✓ COMPLETO' : `PARCIAL ${Math.round(pct * 100)}%`}
                  </span>
                  {rackSelecionado.comprimento_acabado_mm > 0 && (
                    <span className="text-[9px] font-black text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded flex-shrink-0">{fmt(rackSelecionado.comprimento_acabado_mm)} mm</span>
                  )}
                </div>
                <p className="text-[10px] text-gray-500 truncate">{rackSelecionado.produto} · {rackSelecionado.cliente}</p>
                {rackSelecionado.romaneio_numero && (
                  <p className="text-[9px] text-blue-700 font-semibold">📋 {rackSelecionado.romaneio_numero}</p>
                )}
              </div>
            </div>

            {/* Métricas compactas numa linha */}
            <div className="grid grid-cols-4 gap-1.5">
              <div className="bg-white rounded-lg border border-gray-200 px-2 py-1.5">
                <p className="text-[8px] text-gray-400 uppercase font-bold">Peças</p>
                <p className="text-base font-black text-gray-800 leading-tight">{fmt(pecasRack)}</p>
                {pcsPorPalete > 0 && <p className="text-[8px] text-gray-400">/{fmt(pcsPorPalete)}</p>}
              </div>
              <div className={`bg-white rounded-lg border px-2 py-1.5 ${amarradosRack > 0 ? 'border-blue-200' : 'border-gray-200'}`}>
                <p className="text-[8px] text-gray-400 uppercase font-bold">Amarr.</p>
                <p className="text-base font-black text-blue-700 leading-tight">{fmt(amarradosRack)}</p>
                {pcsPorAmarrado > 0 && <p className="text-[8px] text-gray-400">{fmt(pcsPorAmarrado)} pcs</p>}
              </div>
              <div className={`bg-white rounded-lg border px-2 py-1.5 ${completo ? 'border-green-200' : 'border-orange-200'}`}>
                <p className="text-[8px] text-gray-400 uppercase font-bold">Complet.</p>
                <p className={`text-base font-black leading-tight ${completo ? 'text-green-600' : 'text-orange-500'}`}>{Math.round(pct * 100)}%</p>
                {amarradosPalete > 0 && <p className="text-[8px] text-gray-400">{fmt(amarradosRack)}/{fmt(amarradosPalete)}</p>}
              </div>
              <div className="bg-white rounded-lg border border-gray-200 px-2 py-1.5">
                <p className="text-[8px] text-gray-400 uppercase font-bold">Config.</p>
                <p className="text-base font-black text-gray-700 leading-tight">{totalPacotesPalete}</p>
                <p className="text-[8px] text-gray-400">pacotes</p>
              </div>
            </div>

            {/* Barra de progresso compacta */}
            <div className="bg-white rounded-lg border border-gray-200 px-3 py-2">
              <div className="flex justify-between text-[10px] text-gray-500 mb-1">
                <span className="font-semibold">Ocupação do Palete</span>
                <span className="font-black text-gray-700">{Math.round(pct * 100)}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
                <div className={`h-2.5 rounded-full transition-all duration-700 ${completo ? 'bg-green-500' : pct >= 0.5 ? 'bg-yellow-400' : 'bg-red-400'}`}
                  style={{ width: `${Math.round(pct * 100)}%` }} />
              </div>
            </div>

            {/* Vista Lateral — colapsável */}
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <button onClick={() => setSecaoLateralAberta(v => !v)}
                className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-bold text-gray-600 uppercase tracking-wide hover:bg-gray-50 transition-colors">
                <span>Vista Lateral (Esquema)</span>
                <span className="text-gray-400">{secaoLateralAberta ? '▲' : '▼'}</span>
              </button>
              {secaoLateralAberta && (
                <div className="px-3 pb-2 border-t border-gray-100">
                  <DiagramaLateral config={config} completude={pct} pcsPorAmarrado={pcsPorAmarrado} pcsPorPalete={pcsPorPalete} pecasReais={pecasRack} />
                  <div className="flex gap-3 mt-1 text-[9px] text-gray-500">
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-green-300 inline-block border border-green-500"/> Preenchido</span>
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-gray-200 inline-block border border-gray-400"/> Vazio</span>
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-yellow-600 inline-block opacity-70"/> Ripa</span>
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-yellow-300 inline-block border border-yellow-500"/> Base</span>
                  </div>
                </div>
              )}
            </div>

            {/* Vista Superior — colapsável */}
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <button onClick={() => setSecaoPlantaAberta(v => !v)}
                className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-bold text-gray-600 uppercase tracking-wide hover:bg-gray-50 transition-colors">
                <span>Vista Superior — {nCols} coluna{nCols !== 1 ? 's' : ''}</span>
                <span className="text-gray-400">{secaoPlantaAberta ? '▲' : '▼'}</span>
              </button>
              {secaoPlantaAberta && (
                <div className="px-3 pb-2 border-t border-gray-100">
                  <DiagramaPlanta config={config} />
                </div>
              )}
            </div>

            {/* Dimensões — colapsável */}
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <button onClick={() => setSecaoDimsAberta(v => !v)}
                className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-bold text-gray-600 uppercase tracking-wide hover:bg-gray-50 transition-colors">
                <span>Dimensões · L {fmtMm(totalLargMm)} · C {fmtMm(totalProfMm)} · A {fmtMm(totalAltMm)}</span>
                <span className="text-gray-400">{secaoDimsAberta ? '▲' : '▼'}</span>
              </button>
              {secaoDimsAberta && (
                <div className="px-3 pb-2 border-t border-gray-100">
                  <div className="grid grid-cols-3 gap-2 mt-2">
                    {[
                      { label: 'Largura (X)', value: fmtMm(totalLargMm), sub: `${nCols} × ${pkLarg}mm` },
                      { label: 'Comprimento (Z)', value: fmtMm(totalProfMm), sub: `${pkProf}mm material` },
                      { label: 'Altura Total', value: fmtMm(totalAltMm), sub: `112mm base` },
                    ].map(d => (
                      <div key={d.label} className="bg-slate-50 rounded p-2 border border-slate-200">
                        <p className="text-[9px] text-gray-400 font-bold uppercase">{d.label}</p>
                        <p className="text-sm font-black text-gray-800">{d.value}</p>
                        <p className="text-[9px] text-gray-400">{d.sub}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Estrutura — colapsável */}
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <button onClick={() => setSecaoEstruturaAberta(v => !v)}
                className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-bold text-gray-600 uppercase tracking-wide hover:bg-gray-50 transition-colors">
                <span>Estrutura · {config.pacotes_por_camada}pct × {config.camadas_por_bloco}cam × {config.num_blocos}blocos</span>
                <span className="text-gray-400">{secaoEstruturaAberta ? '▲' : '▼'}</span>
              </button>
              {secaoEstruturaAberta && (
                <div className="px-3 pb-2 border-t border-gray-100">
                  <div className="grid grid-cols-4 gap-1.5 mt-2 text-xs">
                    {[
                      { label: 'Pct/cam', value: config.pacotes_por_camada },
                      { label: 'Cam/bloco', value: config.camadas_por_bloco },
                      { label: 'Blocos', value: config.num_blocos },
                      { label: 'Total cam.', value: (config.camadas_por_bloco || 1) * (config.num_blocos || 1) },
                      { label: 'Total pct', value: totalPacotesPalete },
                      { label: 'Ripa cam.', value: config.ripa_entre_camadas ? `${config.ripa_altura_mm}mm` : 'Não' },
                      { label: 'Ripa lat.', value: config.ripa_vertical ? `${config.ripa_vert_comp_mm}mm` : 'Não' },
                      { label: 'Orient.', value: config.orientacao_pacote || 'long.' },
                    ].map(d => (
                      <div key={d.label} className="bg-gray-50 rounded p-1.5 border border-gray-100">
                        <p className="text-[8px] text-gray-400 uppercase">{d.label}</p>
                        <p className="text-xs font-bold text-gray-700">{d.value ?? '-'}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Apontamento — colapsável */}
            {apontamentoRack && (
              <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                <button onClick={() => setSecaoApontamentoAberto(v => !v)}
                  className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-bold text-gray-600 uppercase tracking-wide hover:bg-gray-50 transition-colors">
                  <span>Último Apontamento</span>
                  <span className="text-gray-400">{secaoApontamentoAberto ? '▲' : '▼'}</span>
                </button>
                {secaoApontamentoAberto && (
                  <div className="px-3 pb-2 border-t border-gray-100">
                    <div className="grid grid-cols-2 gap-1.5 mt-2 text-xs">
                      {[
                        { label: 'Operador', value: apontamentoRack.operador || apontamentoRack.usuario },
                        { label: 'Máquina', value: apontamentoRack.maquina },
                        { label: 'Início', value: apontamentoRack.inicio ? new Date(apontamentoRack.inicio).toLocaleString('pt-BR') : '-' },
                        { label: 'Fim', value: apontamentoRack.fim ? new Date(apontamentoRack.fim).toLocaleString('pt-BR') : '-' },
                        { label: 'Rack finalizado', value: apontamentoRack.rack_finalizado ? 'Sim' : 'Não' },
                        { label: 'Qtd. apontada', value: fmt(apontamentoRack.quantidade) + ' pcs' },
                      ].filter(d => d.value && d.value !== '-' && d.value !== 'undefined').map(d => (
                        <div key={d.label} className="bg-gray-50 rounded p-1.5 border border-gray-100">
                          <p className="text-[8px] text-gray-400 uppercase">{d.label}</p>
                          <p className="text-xs font-bold text-gray-700">{d.value}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

          </div>
        )}
      </div>
    </div>
  )
}
