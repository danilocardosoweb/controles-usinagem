import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { Edges, OrbitControls, PerspectiveCamera, Html, Line } from '@react-three/drei'
import { DoubleSide } from 'three'
import { FaTimes, FaCubes, FaSave, FaEdit, FaTruckLoading, FaPlus, FaTrash, FaClipboardList, FaSearch, FaSync, FaExclamationTriangle, FaBan, FaRulerCombined, FaBoxOpen, FaDownload, FaUpload, FaPrint, FaCalendarAlt, FaUser, FaCheck, FaFolderOpen, FaChevronLeft, FaChevronRight } from 'react-icons/fa'
import PaleteVisualizacao3D, { PALETE_CONFIGS, calcularLayoutColunas, calcularDimensoesPalete } from './PaleteVisualizacao3D'
import AmarradoVisualizacao3D from './AmarradoVisualizacao3D'
import PaleteDetalhe2D from './PaleteDetalhe2D'
import { gerarPosicoesAmarrado } from '../utils/geometriaAmarrado'
import { AmarradoService } from '../services/AmarradoService'
import { supabase } from '../config/supabase'
import { useResponsive, getResponsiveClasses } from '../hooks/useResponsive'

// Expor AmarradoService globalmente para debug no console
if (typeof window !== 'undefined') {
  window.AmarradoService = AmarradoService
}

// ─── Helpers de UI definidos FORA do componente pai para evitar remontagem ───
const Valor = ({ v, sufixo = '' }) => (
  <div className="text-lg font-bold text-gray-800">{v ?? '-'}{sufixo && <span className="text-xs font-normal text-gray-400 ml-1">{sufixo}</span>}</div>
)

const BoolVal = ({ v }) => (
  <div className={`text-sm font-semibold ${v ? 'text-green-600' : 'text-gray-400'}`}>{v ? '✓ Sim' : '✗ Não'}</div>
)

const parseColunasRotacionadas = (valor, limite) => {
  let lista = []
  if (Array.isArray(valor)) {
    lista = valor
  } else if (typeof valor === 'string' && valor.trim()) {
    try {
      const parsed = JSON.parse(valor)
      if (Array.isArray(parsed)) lista = parsed
    } catch (err) {
      console.warn('Não foi possível interpretar colunas_rotacionadas:', err)
    }
  } else if (Number.isFinite(valor)) {
    lista = [valor]
  }

  let sanitized = lista
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 0)

  if (typeof limite === 'number' && limite >= 0) {
    sanitized = sanitized.filter((n) => n < limite)
  }

  return Array.from(new Set(sanitized)).sort((a, b) => a - b)
}

const agruparRomaneioItens = (itens = [], romaneiosMap = {}) => {
  const grupos = {}

  itens.forEach((item) => {
    const romaneio = romaneiosMap[item.romaneio_id]
    if (!romaneio) return
    if (item.status_item && item.status_item !== 'conferido') return

    const rackLabel = String(item.rack_ou_pallet || 'PALLET SEM ID').trim() || 'PALLET SEM ID'
    const rackKey = rackLabel.toUpperCase()
    const key = `${item.romaneio_id}-${rackKey}`

    if (!grupos[key]) {
      grupos[key] = {
        key,
        rack: rackLabel,
        romaneioId: romaneio.id,
        romaneioNumero: romaneio.numero_romaneio,
        romaneioStatus: romaneio.status,
        romaneioCliente: romaneio.cliente,
        romaneioDataRef: romaneio.data_expedicao || romaneio.data_conferencia || romaneio.data_criacao,
        clientes: new Set(),
        produtos: new Set(),
        pedidos: new Set(),
        quantidadePecas: 0,
        itens: [],
      }
    }

    const grupo = grupos[key]
    grupo.itens.push(item)
    grupo.quantidadePecas += Number(item.quantidade) || 0
    if (item.cliente) grupo.clientes.add(item.cliente)
    if (item.produto) grupo.produtos.add(item.produto)
    if (item.pedido_seq) grupo.pedidos.add(item.pedido_seq)
    // Capturar o maior comprimento_acabado_mm do grupo (em mm)
    const compMm = Number(item.comprimento_acabado_mm) || 0
    if (compMm > (grupo.comprimentoAcabadoMm || 0)) grupo.comprimentoAcabadoMm = compMm
  })

  return Object.values(grupos)
    .map((grupo) => ({
      ...grupo,
      clientes: Array.from(grupo.clientes),
      produtos: Array.from(grupo.produtos),
      pedidos: Array.from(grupo.pedidos),
    }))
    .sort((a, b) => {
      const va = a.romaneioDataRef ? new Date(a.romaneioDataRef).getTime() : 0
      const vb = b.romaneioDataRef ? new Date(b.romaneioDataRef).getTime() : 0
      return vb - va
    })
}

const MAX_SLOTS_PREVIEW = 220

// Paleta de cores para diferenciar tipos de item na simulação
const ITEM_COLORS = ['#fbbf24','#34d399','#60a5fa','#f472b6','#a78bfa','#fb923c','#2dd4bf','#e879f9']

// ─── 3D BIN-PACKING (Guillotine Axial Correto + Free-Space List) ──────────────
// Espaço livre: { x0, y0, z0, dx, dy, dz } — coordenadas absolutas em metros.
// x = comprimento (0 → comp), y = altura (0 → alt), z = largura (0 → larg).
// Divisão guillotine: ao inserir item (iw×ih×id) num espaço, gera 3 sub-espaços
// com dimensões COMPLETAS do pai nos eixos não consumidos:
//   R (direita X):  x0+iw, z0,    largura TOTAL esp.dz, altura TOTAL esp.dy
//   T (topo Y):     x0,    z0,    largura APENAS id,    dx APENAS iw
//   L (lateral Z):  x0,    z0+id, dx APENAS iw,         altura TOTAL esp.dy
// Best-Fit por menor sobra de volume após inserção.
const packItensNoCaminhao = (filaItens, caminhao, { folgaPerimetroCm = 0, folgaAlturaCm = 0, considerarAltura = true } = {}) => {
  if (!caminhao || !filaItens?.length) return { boxes: [], itensSemEspaco: [] }

  const EPS = 0.001
  const folgaLin = Math.max(0, Number(folgaPerimetroCm) || 0) / 100
  const folgaAlt = Math.max(0, Number(folgaAlturaCm) || 0) / 100
  const compUtil = Math.max(0, caminhao.comprimento - folgaLin * 2)
  const largUtil = Math.max(0, caminhao.largura    - folgaLin * 2)
  const altUtil  = considerarAltura ? Math.max(0, caminhao.altura - folgaAlt) : 999

  // Coordenadas: x=comprimento, y=altura, z=largura — tudo absoluto, origem no canto
  let espacosLivres = [{ x0: 0, y0: 0, z0: 0, dx: compUtil, dy: altUtil, dz: largUtil }]

  const boxes = []
  const itensSemEspaco = []

  // Guillotine axial: divide em 3 sub-espaços com dimensões completas do pai
  // Estratégia Longer Axis Split: divide primeiro pelo eixo maior do resíduo
  const dividirEspaco = (esp, iw, ih, id) => {
    const rdx = esp.dx - iw
    const rdy = esp.dy - ih
    const rdz = esp.dz - id
    const novos = []
    // Fatia direita (X): ocupa toda a altura e largura do espaço pai
    if (rdx > EPS) novos.push({ x0: esp.x0 + iw, y0: esp.y0, z0: esp.z0, dx: rdx,    dy: esp.dy, dz: esp.dz })
    // Fatia topo (Y): acima do item, mesma largura do item, mesmo comprimento do item
    if (rdy > EPS) novos.push({ x0: esp.x0,      y0: esp.y0 + ih, z0: esp.z0, dx: iw, dy: rdy,    dz: id })
    // Fatia lateral (Z): ao lado do item, mesma profundidade X do item, mesma altura do espaço pai
    if (rdz > EPS) novos.push({ x0: esp.x0,      y0: esp.y0, z0: esp.z0 + id, dx: iw, dy: esp.dy, dz: rdz })
    return novos
  }

  const inserirUmaUnidade = (iw, ih, id, cor, titulo, key) => {
    let melhorIdx = -1
    let melhorScore = Infinity
    let melhorRot = false

    for (let i = 0; i < espacosLivres.length; i++) {
      const e = espacosLivres[i]
      // Orientação normal
      if (iw <= e.dx + EPS && ih <= e.dy + EPS && id <= e.dz + EPS) {
        // Score: menor sobra de volume (Best-Fit)
        const score = (e.dx - iw) * e.dy * e.dz + e.dx * (e.dy - ih) * e.dz + e.dx * e.dy * (e.dz - id)
        if (score < melhorScore) { melhorScore = score; melhorIdx = i; melhorRot = false }
      }
      // Rotação 90° no plano horizontal (iw↔id)
      if (id <= e.dx + EPS && ih <= e.dy + EPS && iw <= e.dz + EPS) {
        const score = (e.dx - id) * e.dy * e.dz + e.dx * (e.dy - ih) * e.dz + e.dx * e.dy * (e.dz - iw)
        if (score < melhorScore) { melhorScore = score; melhorIdx = i; melhorRot = true }
      }
    }

    if (melhorIdx === -1) return false

    const esp = espacosLivres[melhorIdx]
    const uw = melhorRot ? id : iw   // comprimento real usado
    const ud = melhorRot ? iw : id   // largura real usada

    // Centro do item em coordenadas absolutas
    boxes.push({
      key,
      xReal: esp.x0 + uw / 2,
      yReal: esp.y0 + ih / 2,
      zReal: esp.z0 + ud / 2,
      wReal: uw,
      hReal: ih,
      dReal: ud,
      cor,
      itemTitulo: titulo,
    })

    const novos = dividirEspaco(esp, uw, ih, ud)
    espacosLivres.splice(melhorIdx, 1, ...novos)
    espacosLivres = espacosLivres.filter(e => e.dx > EPS && e.dy > EPS && e.dz > EPS)
    return true
  }

  filaItens.forEach((item, itemIdx) => {
    const qtd = Math.max(0, Number(item.quantidade) || 0)
    if (qtd === 0) return

    const larg = Number(item.largura)     || 0
    const comp = Number(item.comprimento) || 0
    const alt  = Number(item.altura)      || 0

    if (larg <= 0 || comp <= 0 || alt <= 0) {
      itensSemEspaco.push({ ...item, motivo: 'Dimensões inválidas', tipo: 'dimensoes_invalidas',
        detalhe: { mensagem: 'Uma ou mais dimensões do item são zero ou negativas.' } })
      return
    }
    const menorLado = Math.min(larg, comp)
    const maiorLado = Math.max(larg, comp)
    const cabeLarg = menorLado <= largUtil + EPS
    const cabeComp = menorLado <= compUtil + EPS || maiorLado <= compUtil + EPS
    const cabeAlt  = alt <= altUtil + EPS
    if (!cabeLarg || !cabeAlt) {
      const razoes = []
      if (!cabeLarg) razoes.push({ eixo: 'Largura', itemVal: menorLado, caminhaoVal: largUtil, un: 'm' })
      if (!cabeAlt)  razoes.push({ eixo: 'Altura',  itemVal: alt,       caminhaoVal: altUtil,  un: 'm' })
      const excedeLarg = !cabeLarg ? ((menorLado - largUtil) * 100).toFixed(0) : null
      const excedeAlt  = !cabeAlt  ? ((alt - altUtil) * 100).toFixed(0)       : null
      itensSemEspaco.push({ ...item,
        tipo: 'excede_dimensao',
        motivo: razoes.map(r => `${r.eixo}: ${(r.itemVal*100).toFixed(0)}cm > ${(r.caminhaoVal*100).toFixed(0)}cm útil`).join(' | '),
        detalhe: { razoes, excedeLarg, excedeAlt,
          mensagem: `O item é fisicamente maior que a área útil do caminhão${!cabeLarg ? ` (excede ${excedeLarg}cm na largura)` : ''}${!cabeAlt ? ` (excede ${excedeAlt}cm na altura)` : ''}.` }
      })
      return
    }

    const cor = ITEM_COLORS[itemIdx % ITEM_COLORS.length]
    let naoInseridos = 0
    let inseridos = 0
    for (let u = 0; u < qtd; u++) {
      if (!inserirUmaUnidade(comp, alt, larg, cor, item.titulo, `i${itemIdx}u${u}k${boxes.length}`)) naoInseridos++
      else inseridos++
    }
    if (naoInseridos > 0) {
      const maiorEspacoRestante = espacosLivres.reduce((best, e) => {
        const vol = e.dx * e.dy * e.dz
        return vol > best.vol ? { vol, dx: e.dx, dy: e.dy, dz: e.dz } : best
      }, { vol: 0, dx: 0, dy: 0, dz: 0 })
      itensSemEspaco.push({ ...item, quantidade: naoInseridos,
        tipo: 'sem_espaco',
        motivo: `${naoInseridos} de ${qtd} palete(s) não couberam — espaço insuficiente`,
        detalhe: {
          inseridos, naoInseridos, total: qtd,
          maiorEspacoRestante: {
            comprimento: (maiorEspacoRestante.dx * 100).toFixed(0),
            altura: (maiorEspacoRestante.dy * 100).toFixed(0),
            largura: (maiorEspacoRestante.dz * 100).toFixed(0),
          },
          mensagem: inseridos > 0
            ? `Couberam ${inseridos} de ${qtd}. O maior espaço restante é ${(maiorEspacoRestante.dx*100).toFixed(0)}×${(maiorEspacoRestante.dz*100).toFixed(0)}×${(maiorEspacoRestante.dy*100).toFixed(0)}cm (C×L×A).`
            : `Nenhum palete coube. O maior espaço restante é ${(maiorEspacoRestante.dx*100).toFixed(0)}×${(maiorEspacoRestante.dz*100).toFixed(0)}×${(maiorEspacoRestante.dy*100).toFixed(0)}cm (C×L×A).`
        }
      })
    }
  })

  return { boxes, itensSemEspaco }
}

const TruckPreview3D = ({ caminhao, filaItens = [], folgaPerimetroCm = 10, folgaAlturaCm = 0, considerarAltura = true, viewMode = 'isometrico' }) => {
  const cameraRef = useRef(null)
  const controlsRef = useRef(null)
  const [alertaFechado, setAlertaFechado] = useState(false)

  const { boxes, itensSemEspaco, scale, length, width, height } = useMemo(() => {
    if (!caminhao) return { boxes: [], itensSemEspaco: [], scale: 1, length: 8, width: 2, height: 2 }

    const baseDim = Math.max(caminhao.comprimento, caminhao.largura, 1)
    const scale = 8 / baseDim
    const length = caminhao.comprimento * scale
    const width  = caminhao.largura   * scale
    const height = caminhao.altura    * scale

    const { boxes: rawBoxes, itensSemEspaco } = packItensNoCaminhao(filaItens, caminhao, { folgaPerimetroCm, folgaAlturaCm, considerarAltura })

    const folgaLin = Math.max(0, Number(folgaPerimetroCm) || 0) / 100
    const largUtil = Math.max(0, caminhao.largura - folgaLin * 2)

    // Converter metros reais → coordenadas escaladas centradas no caminhão
    // zReal é absoluto 0..largUtil; centralizar subtraindo largUtil/2
    const boxes = rawBoxes.map(b => ({
      ...b,
      position: [
        (-caminhao.comprimento / 2 + b.xReal) * scale,
        b.yReal * scale,
        (-largUtil / 2 + b.zReal) * scale,
      ],
      dims: [b.wReal * scale * 0.97, b.hReal * scale * 0.97, b.dReal * scale * 0.97],
    }))

    return { boxes, itensSemEspaco, scale, length, width, height }
  }, [caminhao, filaItens, folgaPerimetroCm, folgaAlturaCm, considerarAltura])

  // Reabrir alerta quando a simulação muda
  useEffect(() => { setAlertaFechado(false) }, [itensSemEspaco])

  const cameraPosition = useMemo(() => {
    // Ajuste dinâmico baseado nas dimensões do caminhão
    const maxDim = Math.max(length, width, height)

    if (viewMode === 'lateral') {
      // Vista lateral direita - olhando de lado, enxergando o comprimento total
      return [0, height * 1.2 + 1.5, Math.max(width * 1.5 + 3, length * 0.6 + 2)]
    }
    if (viewMode === 'topo') {
      // Vista de cima (bird's eye) - centralizada, olhando para baixo
      return [0, Math.max(maxDim * 1.3, height + 4), 0]
    }
    if (viewMode === 'frontal') {
      // Vista frontal - de frente para o caminhão
      return [0, height * 1.2 + 1, Math.max(width + 3, 5)]
    }
    // Isométrico padrão (3D)
    return [
      Math.max(8, length * 0.8 + 3),
      Math.max(6, height * 1.6 + 2),
      Math.max(8, width * 1.0 + 4),
    ]
  }, [height, length, width, viewMode])

  const showControls = viewMode === 'livre'

  // Target de visualização - centro do caminhão (ajustado para cada modo)
  const cameraTarget = useMemo(() => {
    if (viewMode === 'topo') return [0, 0, 0] // Olhar para o piso quando vista de cima
    return [0, height / 2, 0] // Centro do caminhão para outros modos
  }, [height, viewMode])

  // Atualizar posição da câmera quando o modo de visualização muda
  useEffect(() => {
    if (cameraRef.current) {
      cameraRef.current.position.set(cameraPosition[0], cameraPosition[1], cameraPosition[2])
      cameraRef.current.lookAt(cameraTarget[0], cameraTarget[1], cameraTarget[2])
    }
    // Sincronizar target do OrbitControls com o target da câmera
    if (controlsRef.current) {
      controlsRef.current.target.set(cameraTarget[0], cameraTarget[1], cameraTarget[2])
      controlsRef.current.update()
    }
  }, [cameraPosition, cameraTarget, viewMode])

  // Controlar habilitação dos controles no modo "Livre"
  useEffect(() => {
    if (controlsRef.current) {
      controlsRef.current.enabled = showControls
      controlsRef.current.enableRotate = showControls
      controlsRef.current.enableZoom = showControls
      controlsRef.current.update()
    }
  }, [showControls])

  const displayedBoxes = boxes.slice(0, MAX_SLOTS_PREVIEW)
  const truckColor = '#38bdf8'

  // Cores únicas dos itens para legenda
  const legendaItens = useMemo(() => {
    const seen = new Map()
    filaItens.forEach((item, idx) => {
      if (!seen.has(item.id)) seen.set(item.id, { titulo: item.titulo, cor: ITEM_COLORS[idx % ITEM_COLORS.length] })
    })
    return [...seen.values()]
  }, [filaItens])

  if (!caminhao) return <div className="text-xs text-slate-500">Selecione um caminhão para visualizar o baú.</div>

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[11px] text-slate-500">
        <span>{caminhao.titulo} · {caminhao.comprimento}m × {caminhao.largura}m × {caminhao.altura}m</span>
        <span>{displayedBoxes.length} paletes posicionados{boxes.length > MAX_SLOTS_PREVIEW ? ` (${MAX_SLOTS_PREVIEW} exibidos)` : ''}</span>
      </div>

      {/* Alertas detalhados de itens que não couberam */}
      {itensSemEspaco.length > 0 && !alertaFechado && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 px-1">
            <FaExclamationTriangle className="text-red-500 text-sm flex-shrink-0" />
            <p className="text-xs font-bold text-red-700 flex-1">{itensSemEspaco.length} item(ns) com restrição</p>
            <button onClick={() => setAlertaFechado(true)} className="text-slate-400 hover:text-red-500 transition-colors p-0.5 rounded hover:bg-red-50" title="Fechar alerta">
              <FaTimes className="w-3 h-3" />
            </button>
          </div>
          {itensSemEspaco.map((it, i) => {
            const icon = it.tipo === 'excede_dimensao' ? <FaRulerCombined className="text-red-500" />
              : it.tipo === 'sem_espaco' ? <FaBoxOpen className="text-amber-500" />
              : <FaBan className="text-slate-500" />
            const borderColor = it.tipo === 'excede_dimensao' ? 'border-red-300 bg-red-50/80'
              : it.tipo === 'sem_espaco' ? 'border-amber-300 bg-amber-50/80'
              : 'border-slate-300 bg-slate-50/80'
            const pct = it.detalhe?.total > 0 ? Math.round((it.detalhe.inseridos / it.detalhe.total) * 100) : 0
            return (
              <div key={i} className={`border rounded-xl px-3 py-2.5 ${borderColor} transition-all`}>
                <div className="flex items-start gap-2">
                  <div className="mt-0.5 text-sm">{icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-slate-800 truncate">{it.titulo}</span>
                      {it.quantidade > 0 && <span className="text-[10px] font-semibold text-slate-500 bg-white/70 rounded-full px-2 py-0.5 flex-shrink-0">{it.quantidade} un.</span>}
                    </div>
                    {/* Dimension comparison for excede_dimensao */}
                    {it.tipo === 'excede_dimensao' && it.detalhe?.razoes && (
                      <div className="mt-1.5 space-y-1">
                        {it.detalhe.razoes.map((r, ri) => (
                          <div key={ri} className="flex items-center gap-1.5 text-[11px]">
                            <span className="text-red-600 font-semibold w-14">{r.eixo}:</span>
                            <span className="text-red-700 font-bold">{(r.itemVal*100).toFixed(0)}cm</span>
                            <span className="text-slate-400 text-[10px]">vs</span>
                            <span className="text-slate-600 font-medium">{(r.caminhaoVal*100).toFixed(0)}cm</span>
                            <span className="text-red-500 font-bold text-[10px]">+{((r.itemVal - r.caminhaoVal)*100).toFixed(0)}cm</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* Progress bar for sem_espaco */}
                    {it.tipo === 'sem_espaco' && it.detalhe && (
                      <div className="mt-1.5">
                        <div className="flex items-center justify-between text-[10px] mb-1">
                          <span className="text-slate-600">Encaixados: <strong className="text-emerald-600">{it.detalhe.inseridos}</strong> de <strong>{it.detalhe.total}</strong></span>
                          <span className="font-bold text-amber-700">{pct}%</span>
                        </div>
                        <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: pct >= 75 ? '#16a34a' : pct >= 40 ? '#f59e0b' : '#ef4444' }} />
                        </div>
                        {it.detalhe.maiorEspacoRestante && (
                          <p className="text-[10px] text-slate-500 mt-1">Maior espaço livre: <strong>{it.detalhe.maiorEspacoRestante.comprimento}×{it.detalhe.maiorEspacoRestante.largura}×{it.detalhe.maiorEspacoRestante.altura}cm</strong> (C×L×A)</p>
                        )}
                      </div>
                    )}
                    {/* Detailed message */}
                    <p className="text-[10px] text-slate-500 mt-1.5 leading-snug">{it.detalhe?.mensagem || it.motivo}</p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="relative h-72 rounded-2xl border border-slate-200 bg-slate-900/60 overflow-hidden">
        <Canvas shadows gl={{ powerPreference: 'low-power', antialias: false }} onCreated={({ gl }) => {
          const canvas = gl.domElement
          canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault() })
          canvas.addEventListener('webglcontextrestored', () => { gl.forceContextRestore?.() })
        }}>
          <PerspectiveCamera ref={cameraRef} makeDefault fov={45} position={cameraPosition} />
          <color attach="background" args={['#0f172a']} />
          <ambientLight intensity={0.9} />
          <directionalLight position={[5, 8, 5]} intensity={0.8} castShadow />
          <group position={[0, 0, 0]}>
            {/* Piso do baú */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
              <planeGeometry args={[length, width]} />
              <meshStandardMaterial color="#1e3a8a" opacity={0.5} transparent />
            </mesh>
            {/* Contorno do baú */}
            <mesh position={[0, height / 2, 0]} renderOrder={1}>
              <boxGeometry args={[length, height, width]} />
              <meshStandardMaterial color={truckColor} transparent opacity={viewMode === 'topo' ? 0.06 : 0.10} depthWrite={false} side={DoubleSide} />
              <Edges scale={1.001} color={truckColor} />
            </mesh>
            {/* Paletes posicionados com dimensões reais */}
            {displayedBoxes.map((box) => (
              <mesh key={box.key} position={box.position} castShadow>
                <boxGeometry args={box.dims} />
                <meshStandardMaterial color={box.cor} opacity={0.92} transparent />
              </mesh>
            ))}

            {/* Cotas dimensionais do caminhão */}
            {/* Cota comprimento (X) — ao longo do eixo frente-fundo, abaixo do piso */}
            <Line
              points={[[-length / 2, -0.08, -width / 2 - 0.12], [length / 2, -0.08, -width / 2 - 0.12]]}
              color="#94a3b8" lineWidth={1}
            />
            <Html position={[0, -0.12, -width / 2 - 0.25]} center style={{ pointerEvents: 'none' }}>
              <span style={{ fontSize: 9, color: '#94a3b8', fontFamily: 'monospace', whiteSpace: 'nowrap', background: 'rgba(0,0,0,0.5)', padding: '1px 4px', borderRadius: 3 }}>
                {caminhao.comprimento}m
              </span>
            </Html>

            {/* Cota largura (Z) — na face frontal, abaixo do piso */}
            <Line
              points={[[length / 2 + 0.12, -0.08, -width / 2], [length / 2 + 0.12, -0.08, width / 2]]}
              color="#94a3b8" lineWidth={1}
            />
            <Html position={[length / 2 + 0.22, -0.12, 0]} center style={{ pointerEvents: 'none' }}>
              <span style={{ fontSize: 9, color: '#94a3b8', fontFamily: 'monospace', whiteSpace: 'nowrap', background: 'rgba(0,0,0,0.5)', padding: '1px 4px', borderRadius: 3 }}>
                {caminhao.largura}m
              </span>
            </Html>

            {/* Cota altura (Y) — na aresta lateral direita */}
            <Line
              points={[[length / 2 + 0.12, 0, -width / 2], [length / 2 + 0.12, height, -width / 2]]}
              color="#94a3b8" lineWidth={1}
            />
            <Html position={[length / 2 + 0.22, height / 2, -width / 2]} center style={{ pointerEvents: 'none' }}>
              <span style={{ fontSize: 9, color: '#94a3b8', fontFamily: 'monospace', whiteSpace: 'nowrap', background: 'rgba(0,0,0,0.5)', padding: '1px 4px', borderRadius: 3 }}>
                {caminhao.altura}m
              </span>
            </Html>
          </group>
          <OrbitControls
            ref={controlsRef}
            enablePan={false}
            enableDamping={true}
            dampingFactor={0.1}
            minPolarAngle={Math.PI / 6}
            maxPolarAngle={Math.PI * 0.95}
            minDistance={3}
            maxDistance={30}
          />
        </Canvas>
        {displayedBoxes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-center text-xs text-slate-200 px-6">
            Adicione itens à fila para visualizar o carregamento.
          </div>
        )}
      </div>

      {/* Legenda dos itens */}
      {legendaItens.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
          {legendaItens.map((it, i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="w-3 h-3 rounded" style={{ background: it.cor }} />
              {it.titulo}
            </span>
          ))}
          {!showControls && <span className="text-slate-400 ml-auto">Visualização fixa ({viewMode})</span>}
        </div>
      )}
    </div>
  )
}

// ─── EDITOR 2D MANUAL DE CUBAGEM (com suporte a camadas/empilhamento) ────────
const TruckManualEditor2D = ({ caminhao, filaItens = [], folgaPerimetroCm = 10, folgaAlturaCm = 0, considerarAltura = true, onPlacementsChange, initialPlacements }) => {
  const svgRef = useRef(null)
  // placements agora inclui: orientacaoFuros ('longitudinal'|'lateral'), acessoBloqueado (boolean)
  const [placements, setPlacements] = useState([]) // { id, itemIdx, x, z, w, d, rotated, cor, titulo, alt, camada, orientacaoFuros, acessoBloqueado }
  const [dragging, setDragging] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [camadaAtual, setCamadaAtual] = useState(0)
  const [totalCamadas, setTotalCamadas] = useState(1)
  const [alertaRotacao, setAlertaRotacao] = useState(null) // { titulo, mensagem, onConfirm, onCancel }

  // Carregar placements iniciais quando fornecidos (ex: ao carregar simulação salva)
  const loadedRef = useRef(null)
  useEffect(() => {
    if (initialPlacements && initialPlacements.length > 0 && loadedRef.current !== initialPlacements) {
      loadedRef.current = initialPlacements
      setPlacements(initialPlacements)
      const maxCamada = initialPlacements.reduce((mx, p) => Math.max(mx, (p.camada || 0) + 1), 1)
      setTotalCamadas(maxCamada)
    }
  }, [initialPlacements])

  const folgaLin = Math.max(0, Number(folgaPerimetroCm) || 0) / 100
  const folgaAlt = Math.max(0, Number(folgaAlturaCm) || 0) / 100
  const compUtil = caminhao ? Math.max(0, caminhao.comprimento - folgaLin * 2) : 0
  const largUtil = caminhao ? Math.max(0, caminhao.largura - folgaLin * 2) : 0
  const altUtil = caminhao ? (considerarAltura ? Math.max(0, caminhao.altura - folgaAlt) : 999) : 0

  const PAD = 16
  const CANVAS_W = 600
  const svgCompPx = CANVAS_W - PAD * 2
  const pxPerM = compUtil > 0 ? svgCompPx / compUtil : 1
  const svgLargPx = largUtil * pxPerM
  const CANVAS_H = svgLargPx + PAD * 2
  const GRID_M = 0.10
  const snap = (v) => Math.round(v / GRID_M) * GRID_M

  // Items on current layer only
  const placementsCamadaAtual = useMemo(() => placements.filter(p => p.camada === camadaAtual), [placements, camadaAtual])
  const placementsOutrasCamadas = useMemo(() => placements.filter(p => p.camada !== camadaAtual), [placements, camadaAtual])

  // Calcular Y real de cada item: apoiado no ponto mais alto diretamente abaixo
  const calcularYPlacements = useCallback((allPlacements) => {
    // Primeiro, resolver o Y de cada camada de baixo para cima
    // yMap: id -> yBase (base inferior do item em metros)
    const yMap = new Map()
    const maxCamada = allPlacements.reduce((mx, p) => Math.max(mx, p.camada || 0), 0)

    for (let c = 0; c <= maxCamada; c++) {
      const itensCamada = allPlacements.filter(p => p.camada === c)
      if (c === 0) {
        itensCamada.forEach(p => yMap.set(p.id, 0))
      } else {
        // Para cada item nesta camada, achar o topo mais alto dos itens abaixo que têm sobreposição 2D
        const itensAbaixo = allPlacements.filter(p => p.camada < c)
        itensCamada.forEach(p => {
          let maxTopoAbaixo = 0
          itensAbaixo.forEach(below => {
            const bY = yMap.get(below.id) || 0
            // Checar sobreposição 2D (x/z)
            const overlapX = p.x < below.x + below.w && p.x + p.w > below.x
            const overlapZ = p.z < below.z + below.d && p.z + p.d > below.z
            if (overlapX && overlapZ) {
              maxTopoAbaixo = Math.max(maxTopoAbaixo, bY + below.alt)
            }
          })
          yMap.set(p.id, maxTopoAbaixo)
        })
      }
    }
    return yMap
  }, [])

  // Collision: only same layer
  const colide = useCallback((id, x, z, w, d, camada) => {
    return placements.some(p => {
      if (p.id === id || p.camada !== camada) return false
      return x < p.x + p.w && x + w > p.x && z < p.z + p.d && z + d > p.z
    })
  }, [placements])

  // Verifica se há espaço para entrada da empilhadeira após rotação
  const validarAcessoEmpilhadeira = useCallback((p, nx, nz, nw, nd) => {
    // Espaço mínimo necessário para entrada dos garfos (em metros)
    const ESPACO_GARFOS = 1.2 // 1.2m de espaço necessário
    
    // Verificar acesso pelos 4 lados
    const acessoFrente = nx >= ESPACO_GARFOS // espaço à frente (x negativo)
    const acessoTras = (nx + nw) <= (compUtil - ESPACO_GARFOS) // espaço atrás
    const acessoEsquerda = nz >= ESPACO_GARFOS // espaço à esquerda (z negativo)
    const acessoDireita = (nz + nd) <= (largUtil - ESPACO_GARFOS) // espaço à direita
    
    // Se orientação é longitudinal, precisa de acesso frontal ou traseiro
    // Se orientação é lateral, precisa de acesso lateral (esquerda ou direita)
    if (p.orientacaoFuros === 'longitudinal') {
      return acessoFrente || acessoTras
    } else {
      return acessoEsquerda || acessoDireita
    }
  }, [compUtil, largUtil])

  // Recalcular acesso bloqueado para todos os placements
  const recalcularAcessoBloqueado = useCallback((allPlacements) => {
    return allPlacements.map(p => {
      const acessoOk = validarAcessoEmpilhadeira(p, p.x, p.z, p.w, p.d)
      return { ...p, acessoBloqueado: !acessoOk }
    })
  }, [validarAcessoEmpilhadeira])

  // Sync placements to parent — enrich with computed Y and recalculate access
  const onPlacementsChangeRef = useRef(onPlacementsChange)
  onPlacementsChangeRef.current = onPlacementsChange
  useEffect(() => {
    const yMap = calcularYPlacements(placements)
    const withAccess = recalcularAcessoBloqueado(placements)
    const enriched = withAccess.map(p => ({
      ...p,
      yCalc: yMap.get(p.id) || 0,
    }))
    onPlacementsChangeRef.current?.(enriched)
  }, [placements, calcularYPlacements, recalcularAcessoBloqueado])

  const svgToMetros = useCallback((svgX, svgY) => ({ x: (svgX - PAD) / pxPerM, z: (svgY - PAD) / pxPerM }), [pxPerM])
  const metrosToSvg = useCallback((mx, mz) => ({ sx: PAD + mx * pxPerM, sy: PAD + mz * pxPerM }), [pxPerM])
  const getSvgPoint = useCallback((e) => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }, [])

  // Check height limit
  const alturaOcupada = useMemo(() => {
    let total = 0
    for (let c = 0; c <= Math.max(camadaAtual, totalCamadas - 1); c++) {
      const itensCamada = placements.filter(p => p.camada === c)
      total += itensCamada.reduce((mx, p) => Math.max(mx, p.alt || 0), 0)
    }
    return total
  }, [placements, camadaAtual, totalCamadas])

  // Calcular Y base para um item hipotético numa posição/camada específica
  const calcularYBaseParaItem = useCallback((x, z, w, d, camada) => {
    if (camada === 0) return 0
    const yMap = calcularYPlacements(placements)
    const itensAbaixo = placements.filter(p => p.camada < camada)
    let maxTopo = 0
    itensAbaixo.forEach(below => {
      const bY = yMap.get(below.id) || 0
      const overlapX = x < below.x + below.w && x + w > below.x
      const overlapZ = z < below.z + below.d && z + d > below.z
      if (overlapX && overlapZ) {
        maxTopo = Math.max(maxTopo, bY + below.alt)
      }
    })
    return maxTopo
  }, [placements, calcularYPlacements])

  const adicionarPalete = useCallback((item, itemIdx) => {
    const origComp = Number(item.comprimento) || 0
    const origLarg = Number(item.largura) || 0
    const origAlt = Number(item.altura) || 1
    if (origComp <= 0 || origLarg <= 0) return

    // Gerar todas as 6 orientações possíveis (3 eixos "em pé" × 2 rotações no plano)
    const dims = [origComp, origLarg, origAlt]
    const orientacoes = []
    for (let hi = 0; hi < 3; hi++) {
      const h = dims[hi]
      const plano = dims.filter((_, i) => i !== hi)
      orientacoes.push({ w: plano[0], d: plano[1], alt: h })
      if (plano[0] !== plano[1]) orientacoes.push({ w: plano[1], d: plano[0], alt: h })
    }
    // Priorizar orientações com menor altura (mais estável)
    orientacoes.sort((a, b) => a.alt - b.alt)

    let bestResult = null
    for (const ori of orientacoes) {
      if (ori.w > compUtil + 0.001 || ori.d > largUtil + 0.001) continue
      let found = false
      for (let iz = 0; iz <= largUtil - ori.d + 0.001 && !found; iz += GRID_M) {
        for (let ix = 0; ix <= compUtil - ori.w + 0.001 && !found; ix += GRID_M) {
          const sx = snap(ix), sz = snap(iz)
          if (!colide(null, sx, sz, ori.w, ori.d, camadaAtual) && sx + ori.w <= compUtil + 0.001 && sz + ori.d <= largUtil + 0.001) {
            // Checar altura nesta posição específica
            if (considerarAltura) {
              const yBase = calcularYBaseParaItem(sx, sz, ori.w, ori.d, camadaAtual)
              if (yBase + ori.alt > altUtil + 0.001) continue
            }
            bestResult = { x: sx, z: sz, ...ori }
            found = true
          }
        }
      }
      if (bestResult) break
    }

    if (!bestResult) return
    // Orientação padrão dos furos: longitudinal (entrada pela frente/trás)
    const orientacaoFuros = item.orientacaoFuros || 'longitudinal'
    const novoPl = {
      id: `man_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      itemIdx, x: bestResult.x, z: bestResult.z,
      w: bestResult.w, d: bestResult.d, alt: bestResult.alt,
      rotated: false,
      cor: ITEM_COLORS[itemIdx % ITEM_COLORS.length],
      titulo: item.titulo, camada: camadaAtual,
      orientacaoFuros, // 'longitudinal' | 'lateral'
      acessoBloqueado: false,
    }
    setPlacements(prev => [...prev, novoPl])
    setSelectedId(novoPl.id)
  }, [compUtil, largUtil, altUtil, colide, GRID_M, camadaAtual, calcularYBaseParaItem, placements, considerarAltura])

  // Girar no plano: troca w ↔ d (comprimento ↔ largura)
  const rotacionar = useCallback(() => {
    if (!selectedId) return
    
    const p = placements.find(pl => pl.id === selectedId)
    if (!p) return
    
    const nw = p.d, nd = p.w
    let nx = p.x, nz = p.z
    if (nx + nw > compUtil) nx = snap(compUtil - nw)
    if (nz + nd > largUtil) nz = snap(largUtil - nd)
    if (nx < 0) nx = 0; if (nz < 0) nz = 0
    if (colide(p.id, nx, nz, nw, nd, p.camada)) return
    
    // Verificar se rotação mantém acessibilidade
    const acessoOk = validarAcessoEmpilhadeira(p, nx, nz, nw, nd)
    
    // Nova orientação após rotação (troca longitudinal ↔ lateral)
    const novaOrientacao = p.orientacaoFuros === 'longitudinal' ? 'lateral' : 'longitudinal'
    
    if (!acessoOk) {
      // Mostrar alerta de confirmação
      setAlertaRotacao({
        titulo: '⚠️ Rotação Inválida',
        mensagem: `Rotacionar este palete bloqueará o acesso dos garfos da empilhadeira.\n\nOrientação atual: ${p.orientacaoFuros === 'longitudinal' ? 'Longitudinal (frente/trás)' : 'Lateral (esquerda/direita)'}\nNova orientação: ${novaOrientacao === 'longitudinal' ? 'Longitudinal' : 'Lateral'}\n\nDeseja confirmar mesmo assim?`,
        onConfirm: () => {
          setPlacements(prev => prev.map(pl => 
            pl.id === selectedId 
              ? { ...pl, x: nx, z: nz, w: nw, d: nd, orientacaoFuros: novaOrientacao, acessoBloqueado: true }
              : pl
          ))
          setAlertaRotacao(null)
        },
        onCancel: () => setAlertaRotacao(null)
      })
      return
    }
    
    // Rotação válida - aplicar normalmente
    setPlacements(prev => prev.map(pl => 
      pl.id === selectedId 
        ? { ...pl, x: nx, z: nz, w: nw, d: nd, orientacaoFuros: novaOrientacao, acessoBloqueado: false }
        : pl
    ))
  }, [selectedId, placements, compUtil, largUtil, colide, snap, validarAcessoEmpilhadeira])

  // Deitar para frente: troca alt ↔ w (altura vira comprimento no plano)
  const deitarFrente = useCallback(() => {
    if (!selectedId) return
    setPlacements(prev => prev.map(p => {
      if (p.id !== selectedId) return p
      const nw = p.alt, nAlt = p.w
      let nx = p.x, nz = p.z
      if (nx + nw > compUtil) nx = snap(compUtil - nw)
      if (nx < 0) nx = 0; if (nz < 0) nz = 0
      if (colide(p.id, nx, nz, nw, p.d, p.camada)) return p
      return { ...p, x: nx, z: nz, w: nw, alt: nAlt }
    }))
  }, [selectedId, compUtil, colide])

  // Tombar de lado: troca alt ↔ d (altura vira largura no plano)
  const deitarLado = useCallback(() => {
    if (!selectedId) return
    setPlacements(prev => prev.map(p => {
      if (p.id !== selectedId) return p
      const nd = p.alt, nAlt = p.d
      let nx = p.x, nz = p.z
      if (nz + nd > largUtil) nz = snap(largUtil - nd)
      if (nx < 0) nx = 0; if (nz < 0) nz = 0
      if (colide(p.id, nx, nz, p.w, nd, p.camada)) return p
      return { ...p, x: nx, z: nz, d: nd, alt: nAlt }
    }))
  }, [selectedId, largUtil, colide])

  const removerSelecionado = useCallback(() => {
    if (!selectedId) return
    setPlacements(prev => prev.filter(p => p.id !== selectedId))
    setSelectedId(null)
  }, [selectedId])

  const handleMouseDown = useCallback((e, plId) => {
    e.stopPropagation()
    setSelectedId(plId)
    const pt = getSvgPoint(e)
    const pl = placements.find(p => p.id === plId)
    if (!pl) return
    const { sx, sy } = metrosToSvg(pl.x, pl.z)
    setDragging({ id: plId, offsetX: pt.x - sx, offsetZ: pt.y - sy })
  }, [placements, getSvgPoint, metrosToSvg])

  const handleMouseMove = useCallback((e) => {
    if (!dragging) return
    const pt = getSvgPoint(e)
    const { x, z } = svgToMetros(pt.x - dragging.offsetX, pt.y - dragging.offsetZ)
    setPlacements(prev => prev.map(p => {
      if (p.id !== dragging.id) return p
      let nx = snap(Math.max(0, Math.min(x, compUtil - p.w)))
      let nz = snap(Math.max(0, Math.min(z, largUtil - p.d)))
      if (colide(p.id, nx, nz, p.w, p.d, p.camada)) return p
      return { ...p, x: nx, z: nz }
    }))
  }, [dragging, getSvgPoint, svgToMetros, compUtil, largUtil, colide])

  const handleMouseUp = useCallback(() => { setDragging(null) }, [])
  const handleBgClick = useCallback(() => { setSelectedId(null) }, [])

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'r' || e.key === 'R') rotacionar()
      if (e.key === 't' || e.key === 'T') deitarFrente()
      if (e.key === 'y' || e.key === 'Y') deitarLado()
      if (e.key === 'Delete' || e.key === 'Backspace') removerSelecionado()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [rotacionar, deitarFrente, deitarLado, removerSelecionado])

  if (!caminhao) return <div className="text-xs text-slate-500">Selecione um caminhão.</div>

  const selectedPl = placements.find(p => p.id === selectedId)
  const countPerCamada = (c) => placements.filter(p => p.camada === c).length

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[11px] text-slate-500">
        <span>{caminhao.titulo} · {compUtil.toFixed(2)}m × {largUtil.toFixed(2)}m (útil)</span>
        <span>{placements.length} paletes · {alturaOcupada > 0 ? `${(alturaOcupada * 100).toFixed(0)}cm de ${(altUtil * 100).toFixed(0)}cm alt.` : ''}</span>
      </div>

      {/* Layer selector */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] font-bold text-slate-400 uppercase mr-1">Camada:</span>
        {Array.from({ length: totalCamadas }).map((_, c) => {
          const n = countPerCamada(c)
          return (
            <button
              key={c}
              onClick={() => setCamadaAtual(c)}
              className={`px-2.5 py-1 rounded-lg text-[10px] font-black transition-all border ${camadaAtual === c
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-md'
                : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300 hover:bg-indigo-50'}`}
            >
              {c === 0 ? 'Chão' : `Nível ${c}`} {n > 0 && <span className="text-[8px] opacity-70">({n})</span>}
            </button>
          )
        })}
        <button
          onClick={() => { setTotalCamadas(prev => prev + 1); setCamadaAtual(totalCamadas) }}
          className="px-2 py-1 rounded-lg border border-dashed border-slate-300 text-[10px] font-bold text-slate-400 hover:text-indigo-600 hover:border-indigo-300 transition-all"
          title="Adicionar camada acima"
        >
          + Nível
        </button>
        {considerarAltura && (
          <span className="ml-auto text-[9px] text-slate-400 font-mono">
            ↕ {(alturaOcupada * 100).toFixed(0)} / {(altUtil * 100).toFixed(0)}cm
          </span>
        )}
      </div>

      {/* Legendas de orientação dos furos */}
      <div className="flex items-center gap-3 text-[9px] text-slate-500 bg-slate-50 rounded-lg px-2 py-1.5 border border-slate-200">
        <span className="font-bold text-slate-400 uppercase">Furos:</span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-full bg-slate-700 opacity-60" />
          <span className="text-green-600">↕</span> Longitudinal (frente/trás)
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-full bg-slate-700 opacity-60" />
          <span className="text-green-600">↔</span> Lateral (esq/dir)
        </span>
        <span className="flex items-center gap-1 ml-auto">
          <span className="w-3 h-3 rounded-full bg-red-500" />
          Acesso bloqueado
        </span>
      </div>

      {/* Toolbar: paletes disponíveis + ações */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-bold text-slate-400 uppercase">Adicionar:</span>
        {filaItens.map((item, idx) => {
          const qtdColocada = placements.filter(p => p.itemIdx === idx).length
          const qtdTotal = Number(item.quantidade) || 0
          const restante = qtdTotal - qtdColocada
          if (restante <= 0) return null
          return (
            <button key={idx} onClick={() => adicionarPalete(item, idx)}
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 transition-all text-[10px] font-bold text-slate-700 active:scale-95">
              <span className="w-2.5 h-2.5 rounded" style={{ background: ITEM_COLORS[idx % ITEM_COLORS.length] }} />
              {item.titulo} <span className="text-slate-400">({restante})</span>
            </button>
          )
        })}
      </div>

      {/* SVG Canvas + painel lateral de ações */}
      <div className="flex items-start gap-2">
      <div className="rounded-xl border border-slate-200 bg-slate-50 overflow-hidden select-none" style={{ maxWidth: CANVAS_W + 2 }}>
        <svg ref={svgRef} width={CANVAS_W} height={Math.max(CANVAS_H, 120)}
          viewBox={`0 0 ${CANVAS_W} ${Math.max(CANVAS_H, 120)}`}
          onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}
          onClick={handleBgClick} style={{ cursor: dragging ? 'grabbing' : 'default' }}>
          <defs>
            <pattern id="grid" width={pxPerM * GRID_M} height={pxPerM * GRID_M} patternUnits="userSpaceOnUse" x={PAD} y={PAD}>
              <rect width={pxPerM * GRID_M} height={pxPerM * GRID_M} fill="none" stroke="#e2e8f0" strokeWidth="0.5" />
            </pattern>
          </defs>
          <rect x={PAD} y={PAD} width={svgCompPx} height={svgLargPx} fill="url(#grid)" stroke="#94a3b8" strokeWidth="1.5" rx="3" />
          <text x={PAD + svgCompPx / 2} y={PAD - 4} textAnchor="middle" style={{ fontSize: 9, fill: '#94a3b8', fontFamily: 'monospace' }}>Comprimento ({compUtil.toFixed(2)}m)</text>
          <text x={PAD - 4} y={PAD + svgLargPx / 2} textAnchor="middle" style={{ fontSize: 9, fill: '#94a3b8', fontFamily: 'monospace' }} transform={`rotate(-90, ${PAD - 4}, ${PAD + svgLargPx / 2})`}>Largura ({largUtil.toFixed(2)}m)</text>

          {/* Ghost outlines from other layers */}
          {placementsOutrasCamadas.map(p => {
            const { sx, sy } = metrosToSvg(p.x, p.z)
            return (
              <rect key={p.id + '_ghost'} x={sx} y={sy} width={p.w * pxPerM} height={p.d * pxPerM} rx="2"
                fill="none" stroke={p.cor} strokeWidth="1" strokeDasharray="3 3" opacity={0.25} />
            )
          })}

          {/* Current layer pallets */}
          {placementsCamadaAtual.map(p => {
            const { sx, sy } = metrosToSvg(p.x, p.z)
            const pw = p.w * pxPerM, pd = p.d * pxPerM
            const isSel = p.id === selectedId
            const orientacao = p.orientacaoFuros || 'longitudinal'
            const acessoBloqueado = p.acessoBloqueado
            
            // Calcular posição dos indicadores de furos
            const furoSize = Math.min(6, pw / 8, pd / 8)
            const furoOffset = Math.min(8, pw / 6, pd / 6)
            
            return (
              <g key={p.id} onMouseDown={(e) => handleMouseDown(e, p.id)} onClick={(e) => e.stopPropagation()} style={{ cursor: dragging?.id === p.id ? 'grabbing' : 'grab' }}>
                <rect x={sx} y={sy} width={pw} height={pd} rx="2"
                  fill={p.cor} fillOpacity={acessoBloqueado ? 0.4 : 0.7} 
                  stroke={acessoBloqueado ? '#ef4444' : (isSel ? '#1e293b' : p.cor)} 
                  strokeWidth={isSel ? 2 : 1}
                  strokeDasharray={acessoBloqueado ? '6 3' : (isSel ? '4 2' : 'none')} />
                
                {/* Indicadores de orientação dos furos — pequenos, nos cantos, não cobrem o texto */}
                {orientacao === 'longitudinal' ? (
                  <>
                    {pw > 24 && pd > 14 && <>
                      <circle cx={sx + 6} cy={sy + 6} r={3} fill="#1e293b" opacity={0.25} />
                      <circle cx={sx + pw - 6} cy={sy + 6} r={3} fill="#1e293b" opacity={0.25} />
                      <circle cx={sx + 6} cy={sy + pd - 6} r={3} fill="#1e293b" opacity={0.25} />
                      <circle cx={sx + pw - 6} cy={sy + pd - 6} r={3} fill="#1e293b" opacity={0.25} />
                    </>}
                    <path d={`M${sx + pw/2 - 7} ${sy - 8} L${sx + pw/2} ${sy - 16} L${sx + pw/2 + 7} ${sy - 8} Z`} fill={acessoBloqueado ? '#ef4444' : '#22c55e'} opacity={0.85} />
                    <path d={`M${sx + pw/2 - 7} ${sy + pd + 8} L${sx + pw/2} ${sy + pd + 16} L${sx + pw/2 + 7} ${sy + pd + 8} Z`} fill={acessoBloqueado ? '#ef4444' : '#22c55e'} opacity={0.85} />
                  </>
                ) : (
                  <>
                    {pw > 14 && pd > 24 && <>
                      <circle cx={sx + 6} cy={sy + 6} r={3} fill="#1e293b" opacity={0.25} />
                      <circle cx={sx + pw - 6} cy={sy + 6} r={3} fill="#1e293b" opacity={0.25} />
                      <circle cx={sx + 6} cy={sy + pd - 6} r={3} fill="#1e293b" opacity={0.25} />
                      <circle cx={sx + pw - 6} cy={sy + pd - 6} r={3} fill="#1e293b" opacity={0.25} />
                    </>}
                    <path d={`M${sx - 8} ${sy + pd/2 - 7} L${sx - 16} ${sy + pd/2} L${sx - 8} ${sy + pd/2 + 7} Z`} fill={acessoBloqueado ? '#ef4444' : '#22c55e'} opacity={0.85} />
                    <path d={`M${sx + pw + 8} ${sy + pd/2 - 7} L${sx + pw + 16} ${sy + pd/2} L${sx + pw + 8} ${sy + pd/2 + 7} Z`} fill={acessoBloqueado ? '#ef4444' : '#22c55e'} opacity={0.85} />
                  </>
                )}
                
                {/* Alerta de acesso bloqueado */}
                {acessoBloqueado && (
                  <g>
                    <circle cx={sx + pw - 8} cy={sy + 8} r={8} fill="#ef4444" />
                    <text x={sx + pw - 8} y={sy + 11} textAnchor="middle" style={{ fontSize: 10, fill: 'white', fontWeight: 'bold' }}>!</text>
                  </g>
                )}
                
                {pw > 30 && pd > 24 && (
                  <text x={sx + pw / 2} y={sy + pd / 2 - (pd > 32 ? 5 : 0)} textAnchor="middle" dominantBaseline="central" style={{ fontSize: Math.min(10, pw / 6), fill: '#1e293b', fontWeight: 800, pointerEvents: 'none' }}>
                    {p.titulo}
                  </text>
                )}
                {pw > 40 && pd > 32 && (
                  <text x={sx + pw / 2} y={sy + pd / 2 + 8} textAnchor="middle" dominantBaseline="central" style={{ fontSize: 8, fill: '#475569', pointerEvents: 'none', fontFamily: 'monospace' }}>
                    {(p.w * 100).toFixed(0)}×{(p.d * 100).toFixed(0)}cm
                  </text>
                )}
              </g>
            )
          })}

          {pxPerM >= 10 && (
            <g>
              <line x1={PAD} y1={CANVAS_H - 6} x2={PAD + pxPerM} y2={CANVAS_H - 6} stroke="#94a3b8" strokeWidth="1" />
              <text x={PAD + pxPerM / 2} y={CANVAS_H - 1} textAnchor="middle" style={{ fontSize: 8, fill: '#94a3b8', fontFamily: 'monospace' }}>1m</text>
            </g>
          )}
        </svg>
      </div>

      {/* Painel lateral de ações */}
      <div className="flex flex-col gap-1.5 pt-1 w-14">
        {selectedId && (
          <>
            <button onClick={rotacionar} className="w-full py-1.5 rounded border border-slate-200 bg-white hover:bg-amber-50 hover:border-amber-300 text-[9px] font-bold text-slate-600 transition-all leading-tight" title="Girar no plano (R)">↻<br/>Girar</button>
            <button onClick={deitarFrente} className="w-full py-1.5 rounded border border-slate-200 bg-white hover:bg-indigo-50 hover:border-indigo-300 text-[9px] font-bold text-slate-600 transition-all leading-tight" title="Deitar p/ frente (T)">⤵<br/>Deitar</button>
            <button onClick={deitarLado} className="w-full py-1.5 rounded border border-slate-200 bg-white hover:bg-violet-50 hover:border-violet-300 text-[9px] font-bold text-slate-600 transition-all leading-tight" title="Tombar de lado (Y)">⤳<br/>Tombar</button>
            <div className="w-full h-px bg-slate-200 my-0.5" />
            <button onClick={removerSelecionado} className="w-full py-1.5 rounded border border-red-200 bg-white hover:bg-red-50 hover:border-red-300 text-[9px] font-bold text-red-500 transition-all leading-tight" title="Remover (Del)">✕<br/>Del</button>
            <div className="w-full h-px bg-slate-200 my-0.5" />
          </>
        )}
        {placements.length > 0 && (
          <button
            onClick={() => { setPlacements([]); setSelectedId(null) }}
            className="w-full py-1.5 rounded border border-red-300 bg-red-50 hover:bg-red-100 text-[9px] font-bold text-red-600 transition-all leading-tight"
            title="Remover todos os paletes"
          >🗑️<br/>Todos</button>
        )}
      </div>
      </div>

      {/* Info bar */}
      {selectedPl && (
        <div className="flex items-center gap-3 text-[10px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 flex-wrap">
          <span className="w-2.5 h-2.5 rounded" style={{ background: selectedPl.cor }} />
          <strong className="text-slate-700">{selectedPl.titulo}</strong>
          <span>{(selectedPl.w * 100).toFixed(0)}×{(selectedPl.d * 100).toFixed(0)}cm · Alt {(selectedPl.alt * 100).toFixed(0)}cm</span>
          <span>Camada {selectedPl.camada === 0 ? 'Chão' : `Nível ${selectedPl.camada}`}</span>
          <span>X={selectedPl.x.toFixed(2)}m Z={selectedPl.z.toFixed(2)}m</span>
          {/* Status de orientação dos furos */}
          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${selectedPl.acessoBloqueado ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
            {selectedPl.orientacaoFuros === 'longitudinal' ? '↕ Frente/Trás' : '↔ Lateral'}
            {selectedPl.acessoBloqueado && ' (Bloqueado!)'}
          </span>
          <span className="text-slate-400 ml-auto">R=girar · T=deitar · Y=tombar · Del</span>
        </div>
      )}

      {/* Alerta de confirmação para rotação inválida */}
      {alertaRotacao && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setAlertaRotacao(null)}>
          <div className="bg-white rounded-xl shadow-xl p-5 max-w-md mx-4 border border-red-200" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-full bg-red-100 text-red-600 flex items-center justify-center">
                <span className="text-lg">⚠️</span>
              </div>
              <h3 className="text-sm font-black text-slate-800 uppercase">{alertaRotacao.titulo}</h3>
            </div>
            <p className="text-xs text-slate-600 mb-4 whitespace-pre-line leading-relaxed">{alertaRotacao.mensagem}</p>
            <div className="flex gap-2">
              <button
                onClick={alertaRotacao.onCancel}
                className="flex-1 px-3 py-2 rounded-lg border border-slate-300 text-xs font-bold text-slate-600 hover:bg-slate-50 transition-all"
              >
                Cancelar
              </button>
              <button
                onClick={alertaRotacao.onConfirm}
                className="flex-1 px-3 py-2 rounded-lg bg-red-600 text-white text-xs font-bold hover:bg-red-700 transition-all"
              >
                Confirmar Mesmo Assim
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const gerarId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const CAMINHOES_SIMULACAO = [
  {
    id: 'sider',
    titulo: 'Sider',
    subtitulo: 'Laterais com lona',
    comprimento: 14.5,
    largura: 2.60,
    altura: 2.80,
    observacao: 'Flexível para cargas longas com abertura lateral completa.',
  },
  {
    id: 'bau_furgao',
    titulo: 'Baú (Furgão)',
    subtitulo: 'Fechado padrão',
    comprimento: 14.0,
    largura: 2.48,
    altura: 2.70,
    observacao: 'Proteção total contra intempéries, ideal para perfis acabados.',
  },
  {
    id: 'bau_refrigerado',
    titulo: 'Baú Refrigerado',
    subtitulo: 'Isotérmico',
    comprimento: 13.5,
    largura: 2.40,
    altura: 2.60,
    observacao: 'Isolamento reduz a área útil – considerar folgas extras.',
  },
  {
    id: 'carga_seca',
    titulo: 'Carga Seca',
    subtitulo: 'Com lona',
    comprimento: 15.0,
    largura: 2.65,
    altura: 2.90,
    observacao: 'Estrado alto, mas permite sobrealtura com lonas.',
  },
  {
    id: 'vuc',
    titulo: 'VUC',
    subtitulo: 'Veículo Urbano de Carga',
    comprimento: 7.2,
    largura: 2.30,
    altura: 2.30,
    observacao: 'Indicados para entregas urbanas e locais com restrição.',
  },
  {
    id: 'toco',
    titulo: 'Toco',
    subtitulo: '2 eixos',
    comprimento: 9.5,
    largura: 2.45,
    altura: 2.60,
    observacao: 'Boa relação entre capacidade e consumo.',
  },
  {
    id: 'truck',
    titulo: 'Truck',
    subtitulo: '3 eixos',
    comprimento: 11.5,
    largura: 2.48,
    altura: 2.75,
    observacao: 'O mais usado para expedições mistas.',
  },
  {
    id: 'carreta',
    titulo: 'Carreta',
    subtitulo: '4 eixos / LS',
    comprimento: 16.0,
    largura: 2.60,
    altura: 2.90,
    observacao: 'Maior capacidade para cargas longas e volumosas.',
  },
  {
    id: 'bitrem',
    titulo: 'Bitrem',
    subtitulo: '9 eixos (2 unidades)',
    comprimento: 19.8,
    largura: 2.60,
    altura: 2.90,
    observacao: 'Máxima capacidade para grandes volumes.',
  },
  {
    id: 'graneleiro',
    titulo: 'Graneleiro',
    subtitulo: 'Caçamba aberta',
    comprimento: 14.5,
    largura: 2.60,
    altura: 2.80,
    observacao: 'Ideal para perfis sem embalagem ou em caçambas.',
  },
  {
    id: 'fiorino',
    titulo: 'Fiorino / Utilitário',
    subtitulo: 'Entrega expressa',
    comprimento: 2.80,
    largura: 1.60,
    altura: 1.40,
    observacao: 'Pequenas entregas urgentes e retiradas de showroom.',
  },
]

const mmToM = (valor) => {
  const numerico = Number(valor)
  if (!Number.isFinite(numerico)) return 0
  return numerico / 1000
}

const montarItemSimulacao = (metrics) => {
  if (!metrics) return null
  // comprimento = maior dimensão horizontal (comprimento físico do material)
  // largura     = menor dimensão horizontal (extensão lateral do palete)
  const largura     = Math.min(metrics.totalLarg, metrics.totalProf)
  const comprimento = Math.max(metrics.totalLarg, metrics.totalProf)
  return {
    titulo: 'Palete configurado',
    subtitulo: `${metrics.totalPacotes} pacotes`,
    largura,
    comprimento,
    altura: metrics.totalAlt,
    volume: largura * comprimento * metrics.totalAlt,
    quantidade: 1,
    pesoPacoteKg: metrics.pesoPacoteKg || 0,
    totalPacotes: metrics.totalPacotes || 1,
  }
}

const escolher_orientacao = (item, espaco) => {
  if (!item || !espaco) return null
  const larguraEspaco = Math.max(0, Number(espaco.largura) || 0)
  const comprimentoEspaco = Math.max(0, Number(espaco.comprimento) || 0)
  if (larguraEspaco <= 0 || comprimentoEspaco <= 0) return null

  const areaUtil = larguraEspaco * comprimentoEspaco
  const avaliar = (tipo_orientacao, largura, comprimento) => {
    const larg = Number(largura) || 0
    const comp = Number(comprimento) || 0
    if (larg <= 0 || comp <= 0) return null
    if (larg > larguraEspaco || comp > comprimentoEspaco) return null
    const colunas = Math.floor(comprimentoEspaco / comp)
    const linhas = Math.floor(larguraEspaco / larg)
    if (colunas <= 0 || linhas <= 0) return null
    const capacidadePorPiso = colunas * linhas
    const areaOcupada = capacidadePorPiso * (larg * comp)
    const sobra_area = Math.max(0, areaUtil - areaOcupada)
    return {
      tipo_orientacao,
      largura_final: larg,
      comprimento_final: comp,
      largura: larg,
      comprimento: comp,
      colunas,
      linhas,
      capacidadePorPiso,
      sobra_area,
      sobraComprimento: Math.max(0, comprimentoEspaco - colunas * comp),
      sobraLargura: Math.max(0, larguraEspaco - linhas * larg),
    }
  }

  const normal = avaliar('normal', item.largura, item.comprimento)
  const rotacionado = avaliar('rotacionado', item.comprimento, item.largura)

  if (normal && rotacionado) {
    return rotacionado.sobra_area < normal.sobra_area ? rotacionado : normal
  }
  if (normal) return normal
  if (rotacionado) return rotacionado
  return null
}

const calcularCapacidadeNoCaminhao = (item, caminhao, { folgaPerimetroCm = 0, folgaAlturaCm = 0, considerarAltura = true } = {}) => {
  if (!item || !caminhao) return null
  const larguraItem = item.largura || 0
  const comprimentoItem = item.comprimento || 0
  const alturaItem = item.altura || 0
  if (larguraItem <= 0 || comprimentoItem <= 0) return null

  const folgaLinear = Math.max(0, Number(folgaPerimetroCm) || 0) / 100
  const folgaAltura = Math.max(0, Number(folgaAlturaCm) || 0) / 100
  const compUtil = Math.max(0, caminhao.comprimento - folgaLinear * 2)
  const largUtil = Math.max(0, caminhao.largura - folgaLinear * 2)
  const altUtil = considerarAltura
    ? Math.max(0, caminhao.altura - folgaAltura)
    : caminhao.altura

  const melhor = escolher_orientacao(
    { largura: larguraItem, comprimento: comprimentoItem },
    { largura: largUtil, comprimento: compUtil }
  )
  if (!melhor) return null
  const chave = melhor.tipo_orientacao === 'rotacionado' ? 'rotacionado' : 'padrao'

  const camadasVerticais = considerarAltura && alturaItem > 0
    ? Math.max(1, Math.floor(altUtil / alturaItem))
    : 1

  const capacidadeTotal = melhor.capacidadePorPiso * camadasVerticais
  const volumeItem = item.volume || (larguraItem * comprimentoItem * alturaItem)
  // Volume útil do caminhão sempre usa altura do caminhão (altUtil)
  const volumeUtil = compUtil * largUtil * altUtil
  // Ocupação = volume total ocupado (capacidade × volume por item) / volume útil do caminhão
  const volumeTotalOcupado = capacidadeTotal * volumeItem
  const ocupacaoVolume = volumeUtil > 0 && volumeTotalOcupado > 0
    ? Math.min(1, volumeTotalOcupado / volumeUtil)
    : 0

  return {
    ...melhor,
    chave,
    camadasVerticais,
    capacidadeTotal,
    volumeItem,
    volumeUtil,
    ocupacaoVolume,
    compUtil,
    largUtil,
    altUtil,
    sobraComprimento: melhor.sobraComprimento,
    sobraLargura: melhor.sobraLargura,
  }
}

const AMARRADO_DEFAULT = {
  tipo: 'circular', // circular | retangular
  quantidade: 20,
  pecas_por_linha: 5,
  largura: 50, // diâmetro ou largura
  altura: 50,  // altura (retangular)
  espacamento: 2,
  comprimento: 2000,
  cor: '#a0a0a0',
  mostrar_filme: true,
}

const FORM_DEFAULT = {
  // ========== SEÇÃO 1: PALETE ==========
  tipo_palete:           'PBR_1200x1000',
  pacotes_por_camada:    3,
  camadas_por_bloco:     3,
  num_blocos:            3,

  // ========== SEÇÃO 2: RIPAS ENTRE CAMADAS ==========
  ripa_entre_camadas:    true,
  num_ripas_por_camada:  3,
  ripas_entre_posicao:   'uniforme',    // uniforme | centro | extremos | manual
  ripas_entre_offset_mm: 0,             // offset de ajuste fino em mm
  ripas_entre_manual:    false,           // modo manual ativado
  ripas_entre_posicoes:  '',             // JSON: posições Z específicas [z1, z2, z3...]
  ripa_altura_mm:        17,
  ripa_largura_mm:       75,
  ripa_comprimento_mm:   1200,           // comprimento da ripa transversal
  ripa_topo:             true,

  // ========== SEÇÃO 2B: CAMADA FINAL (AJUSTE DE ALTURA) ==========
  camada_final_ativa:    false,         // ativar camada final com qtd diferente
  camada_final_qtd:      1,               // quantidade de pacotes na camada final (1-12)
  camada_final_posicao:  'centralizada',  // 'centralizada' | 'uniforme' | 'manual'

  // ========== SEÇÃO 1B: MULTI-PILHA (quando material menor que palete) ==========
  multi_pilha_ativa:     false,         // ativar múltiplas pilhas no mesmo palete
  multi_pilha_qtd:       1,              // quantidade de pilhas (1-4)
  multi_pilha_folga_mm:  50,             // folga mínima entre pilhas (mm)

  // ========== SEÇÃO 3: RIPAS LATERAIS (QUADRO) ==========
  ripa_vertical:         true,
  num_ripas_lateral:     3,
  ripas_lat_posicao:     'uniforme',    // uniforme | cantos | centro | manual
  ripas_lat_offset_mm:   0,             // offset de ajuste fino em mm
  ripas_lat_manual:      false,         // modo manual ativado
  ripas_lat_posicoes:    '',            // JSON: posições Z específicas [z1, z2, z3...]
  ripas_lat_margem_mm:   40,
  ripa_vert_largura_mm:  17,
  ripa_vert_comp_mm:     75,
  ripa_vert_altura_mm:   1080,

  // ========== PACOTE ==========
  largura_pacote_mm:     300,
  altura_pacote_mm:      100,
  profundidade_pacote_mm: 6000,
  orientacao_pacote:     'longitudinal', // longitudinal | transversal
  cor_pacote:            '#b0b8c1',
  colunas_rotacionadas:  [],

  // Meta
  descricao_montagem:    '',
  mostrar_cotas:         true,  // mostrar/ocultar cotas de dimensão na visualização
  peso_pacote_kg:        '',    // peso por pacote em kg (para estimativa de peso total)
}

// ─── Mini-componentes do painel lateral ───────────────────────────────────────
const inputCls = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200 transition-all placeholder:text-slate-400'

const colorMap = {
  amber: { bg: 'bg-amber-600', border: 'border-amber-200', light: 'bg-amber-50', text: 'text-amber-800' },
  orange: { bg: 'bg-orange-600', border: 'border-orange-200', light: 'bg-orange-50', text: 'text-orange-800' },
  green:  { bg: 'bg-emerald-600', border: 'border-emerald-200', light: 'bg-emerald-50', text: 'text-emerald-800' },
  blue:   { bg: 'bg-indigo-600', border: 'border-indigo-200', light: 'bg-indigo-50', text: 'text-indigo-800' },
  gray:   { bg: 'bg-slate-500', border: 'border-slate-200', light: 'bg-slate-50', text: 'text-slate-800' },
}

const SectionBlock = ({ title, color = 'amber', number, children }) => {
  const c = colorMap[color] || colorMap.amber
  return (
    <div className={`mx-4 mb-5 rounded-2xl border ${c.border} bg-white shadow-sm overflow-hidden transition-all hover:shadow-md`}>
      <div className={`flex items-center gap-2.5 px-4 py-3 ${c.light}`}>
        <span className={`w-6 h-6 ${c.bg} text-white rounded-lg flex items-center justify-center text-[11px] font-black shadow-sm shrink-0`}>
          {number}
        </span>
        <span className={`text-[12px] font-bold ${c.text} uppercase tracking-wider`}>{title}</span>
      </div>
      <div className="px-4 py-4 space-y-4">{children}</div>
    </div>
  )
}

const Row = ({ label, children }) => (
  <div className="flex items-center justify-between gap-4 py-1">
    <span className="text-xs text-slate-500 font-semibold tracking-tight shrink-0">{label}</span>
    <div className="flex-1 flex justify-end">{children}</div>
  </div>
)

const Val = ({ children, sufixo }) => (
  <span className="text-sm font-bold text-slate-800">
    {children ?? '—'}{sufixo && <span className="text-slate-400 font-medium ml-1 text-xs">{sufixo}</span>}
  </span>
)

const FieldLabel = ({ children }) => (
  <p className="text-[11px] text-slate-400 font-bold uppercase tracking-tight mb-1.5">{children}</p>
)

const Divider = () => <div className="border-t border-slate-100 my-1" />

const Toggle = ({ name, checked, editando, onChange }) => {
  if (!editando) {
    return (
      <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold transition-all ${checked ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>
        {checked ? <span className="text-[10px]">● SIM</span> : <span className="text-[10px]">○ NÃO</span>}
      </div>
    )
  }
  return (
    <label className="group flex items-center gap-2 cursor-pointer select-none">
      <div className="relative">
        <input type="checkbox" name={name} checked={!!checked} onChange={onChange} className="sr-only" />
        <div className={`w-11 h-6 rounded-full transition-all duration-300 ${checked ? 'bg-amber-500' : 'bg-slate-300'}`}>
          <div className={`w-4.5 h-4.5 rounded-full bg-white shadow-md absolute top-0.75 transition-all duration-300 ${checked ? 'translate-x-5.5' : 'translate-x-0.75'}`} />
        </div>
      </div>
      <span className={`text-xs font-bold transition-colors ${checked ? 'text-amber-600' : 'text-slate-400'}`}>
        {checked ? 'SIM' : 'NÃO'}
      </span>
    </label>
  )
}

const Trio = ({ labels, names, min = 1, max = 20000, twoOnly = false, editando, form, handleChange, config, unit }) => {
  const cols = twoOnly ? 2 : 3
  const activeNames = twoOnly ? names.slice(0, 2) : names
  const activeLabels = twoOnly ? labels.slice(0, 2) : labels
  
  return (
    <div className={`grid grid-cols-${cols} gap-3`}>
      {activeNames.map((name, i) => (
        <div key={name}>
          <FieldLabel>{activeLabels[i]}</FieldLabel>
          {editando
            ? <div className="relative">
                <input
                  type="number"
                  name={name}
                  value={form[name] ?? ''}
                  onChange={handleChange}
                  min={Array.isArray(min) ? min[i] : min}
                  max={Array.isArray(max) ? max[i] : max}
                  className={`${inputCls} pr-7`}
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-300 font-mono">mm</span>
              </div>
            : <Val sufixo="mm">{config?.[name]}</Val>
          }
        </div>
      ))}
    </div>
  )
}

const Chip = ({ children, color = 'gray' }) => {
  const c = colorMap[color] || colorMap.gray
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border ${c.border} ${c.light} text-gray-700`}>
      {children}
    </span>
  )
}

export const PaleteConteudo = ({ ferramenta, comprimento, isAdmin = false, onClose, onActiveTabChange, simulacaoId, onSimulacaoLoaded }) => {
  const open = true
  const [config, setConfig] = useState(null)
  const [loading, setLoading] = useState(false)
  const [editando, setEditando] = useState(false)
  const [amarrado, setAmarrado] = useState(AMARRADO_DEFAULT)
  const [activeTab, setActiveTab] = useState(simulacaoId ? 'cubagem' : 'visualizacao')
  const [form, setForm] = useState(FORM_DEFAULT)
  const [msg, setMsg] = useState('')
  
  // Estados para gerenciar modelos de amarrado
  const [modelosAmarrado, setModelosAmarrado] = useState([])
  const [carregandoModelos, setCarregandoModelos] = useState(false)
  const [salvandoModelo, setSalvandoModelo] = useState(false)
  const [showSalvarModeloModal, setShowSalvarModeloModal] = useState(false)
  const [showCarregarModeloModal, setShowCarregarModeloModal] = useState(false)
  const [nomeNovoModelo, setNomeNovoModelo] = useState('')
  const [descricaoNovoModelo, setDescricaoNovoModelo] = useState('')
  const [modeloAmarradoSelecionado, setModeloAmarradoSelecionado] = useState(null) // Para usar na visualização 3D

  const handleAmarradoChange = (e) => {
    const { name, value, type, checked } = e.target
    setAmarrado(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : (type === 'number' ? Number(value) : value)
    }))
  }

  // Carregar modelos de amarrado ao abrir a aba
  useEffect(() => {
    if (activeTab === 'amarrado' || activeTab === 'visualizacao') {
      carregarModelosAmarrado()
    }
  }, [activeTab])

  // Recarregar modelos quando ferramenta ou comprimento mudar
  useEffect(() => {
    if ((activeTab === 'visualizacao' || activeTab === 'amarrado') && ferramenta) {
      carregarModelosAmarrado()
    }
  }, [ferramenta, comprimento, activeTab])

  const carregarModelosAmarrado = async () => {
    setCarregandoModelos(true)
    try {
      // Se não temos ferramenta, não carrega nada
      if (!ferramenta) {
        console.log('⚠️ Ferramenta não selecionada, não carregando modelos')
        setModelosAmarrado([])
        setCarregandoModelos(false)
        return
      }

      const comprimentoNum = comprimento ? parseInt(comprimento, 10) : null
      const filtros = {
        ferramenta,
        ...(comprimentoNum && { comprimento_mm: comprimentoNum })
      }
      
      console.log('📥 Carregando modelos com filtros:', filtros)
      console.log(`   Ferramenta: "${ferramenta}" (tipo: ${typeof ferramenta})`)
      console.log(`   Comprimento: ${comprimentoNum} (tipo: ${typeof comprimentoNum})`)
      
      const resultado = await AmarradoService.carregarModelos(filtros)
      
      if (resultado.success) {
        const modelos = resultado.data || []
        setModelosAmarrado(modelos)
        console.log(`✅ ${modelos.length} modelo(s) encontrado(s) para ${ferramenta}${comprimentoNum ? ` / ${comprimentoNum}mm` : ''}`)
        
        // Se não encontrou nada, sugerir debug
        if (modelos.length === 0) {
          console.warn('⚠️ Nenhum modelo encontrado. Execute: await AmarradoService.debugListarTodos()')
        }
      } else {
        console.error('❌ Erro ao carregar modelos:', resultado.error)
        setModelosAmarrado([])
      }
    } catch (error) {
      console.error('❌ Exceção ao carregar modelos:', error)
      setModelosAmarrado([])
    } finally {
      setCarregandoModelos(false)
    }
  }

  const salvarNovoModelo = async () => {
    if (!nomeNovoModelo.trim()) {
      setMsg('❌ Informe um nome para o modelo')
      setTimeout(() => setMsg(''), 3000)
      return
    }

    if (!ferramenta) {
      setMsg('❌ Ferramenta não selecionada')
      setTimeout(() => setMsg(''), 3000)
      return
    }

    if (!comprimento) {
      setMsg('❌ Comprimento não informado')
      setTimeout(() => setMsg(''), 3000)
      return
    }

    setSalvandoModelo(true)
    try {
      // Verificar se modelo com mesmo nome + ferramenta + comprimento já existe
      const modeloExistente = modelosAmarrado.find(m => 
        m.nome === nomeNovoModelo && 
        m.ferramenta === ferramenta && 
        m.comprimento_mm === parseInt(comprimento, 10)
      )

      const novoModelo = {
        ...amarrado,
        nome: nomeNovoModelo,
        descricao: descricaoNovoModelo,
        ferramenta,
        comprimento: Number(comprimento) || 0, // comprimento do perfil em mm
        comprimento_mm: Number(comprimento) || 0, // comprimento da ferramenta em mm
      }

      console.log('📝 Salvando modelo:', novoModelo)
      const resultado = await AmarradoService.salvarModelo(novoModelo)
      
      if (resultado.success) {
        setShowSalvarModeloModal(false)
        setNomeNovoModelo('')
        setDescricaoNovoModelo('')
        await carregarModelosAmarrado()
        
        // Mensagem diferente para novo modelo vs atualização
        if (modeloExistente) {
          setMsg('✏️ Modelo atualizado com sucesso!')
        } else {
          setMsg('✅ Novo modelo salvo com sucesso!')
        }
        setTimeout(() => setMsg(''), 4000)
      } else {
        console.error('❌ Erro ao salvar:', resultado.error)
        setMsg(`❌ Erro: ${resultado.error}`)
        setTimeout(() => setMsg(''), 4000)
      }
    } catch (error) {
      console.error('❌ Exceção ao salvar modelo:', error)
      setMsg(`❌ Erro: ${error.message}`)
      setTimeout(() => setMsg(''), 4000)
    } finally {
      setSalvandoModelo(false)
    }
  }

  const carregarModeloSelecionado = async (modeloId) => {
    const resultado = await AmarradoService.carregarModeloPorId(modeloId)
    if (resultado.success) {
      const modelo = resultado.data
      setAmarrado({
        tipo: modelo.tipo,
        quantidade: modelo.quantidade,
        pecas_por_linha: modelo.pecas_por_linha,
        largura: modelo.largura,
        altura: modelo.altura,
        espacamento: modelo.espacamento,
        comprimento: modelo.comprimento,
        cor: modelo.cor,
        mostrar_filme: modelo.mostrar_filme,
      })
      setShowCarregarModeloModal(false)
      setMsg(`Modelo "${modelo.nome}" carregado!`)
      setTimeout(() => setMsg(''), 3000)
    } else {
      alert('Erro ao carregar modelo: ' + resultado.error)
    }
  }

  const deletarModelo = async (modeloId) => {
    if (!confirm('Tem certeza que deseja deletar este modelo?')) return
    
    const resultado = await AmarradoService.deletarModelo(modeloId)
    if (resultado.success) {
      await carregarModelosAmarrado()
      setMsg('Modelo deletado com sucesso!')
      setTimeout(() => setMsg(''), 3000)
    } else {
      alert('Erro ao deletar modelo: ' + resultado.error)
    }
  }

  useEffect(() => {
    if (activeTab !== 'amarrado') return
    
    const canvas = document.getElementById('amarrado2d')
    if (!canvas) return
    
    const ctx = canvas.getContext('2d')
    const { posicoes, boundingBox } = gerarPosicoesAmarrado({
      tipo: amarrado.tipo,
      quantidade: amarrado.quantidade,
      pecasPorLinha: amarrado.pecas_por_linha,
      largura: amarrado.largura,
      altura: amarrado.altura,
      espacamento: amarrado.espacamento
    })

    // Limpar e configurar escala
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    
    const padding = 20
    const scale = Math.min(
      (canvas.width - padding) / boundingBox.width,
      (canvas.height - padding) / boundingBox.height
    )

    ctx.save()
    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.scale(scale, -scale) // Inverter Y para coordenadas cartesianas

    ctx.strokeStyle = '#475569'
    ctx.lineWidth = 1 / scale
    ctx.fillStyle = amarrado.cor

    posicoes.forEach(pos => {
      ctx.beginPath()
      if (amarrado.tipo === 'circular') {
        ctx.arc(pos.x, pos.y, amarrado.largura / 2, 0, Math.PI * 2)
      } else {
        ctx.rect(pos.x - amarrado.largura / 2, pos.y - amarrado.altura / 2, amarrado.largura, amarrado.altura)
      }
      ctx.fill()
      ctx.stroke()
    })

    ctx.restore()
  }, [activeTab, amarrado])

  const [filaItens, setFilaItens] = useState([])
  const [itemSelecionadoId, setItemSelecionadoId] = useState(null)
  const [caminhaoSelecionado, setCaminhaoSelecionado] = useState(CAMINHOES_SIMULACAO[0].id)
  const [folgaPerimetroCm, setFolgaPerimetroCm] = useState(10)
  const [folgaAlturaCm, setFolgaAlturaCm] = useState(0)
  const [considerarAltura, setConsiderarAltura] = useState(true)
  const [truckViewMode, setTruckViewMode] = useState('isometrico')
  const [modoCubagem, setModoCubagem] = useState('automatico') // 'automatico' | 'manual'
  const [manualPlacements, setManualPlacements] = useState([])
  const [loadedPlacements, setLoadedPlacements] = useState(null) // only set when loading a saved simulation
  const [showFolgas, setShowFolgas] = useState(false)
  const [caminhoesExpandido, setCaminhoesExpandido] = useState(false)
  // Save/Load/Export simulação
  const [showSalvarModal, setShowSalvarModal] = useState(false)
  const [showCarregarModal, setShowCarregarModal] = useState(false)
  const [showExportView, setShowExportView] = useState(false)
  const [simulacoesSalvas, setSimulacoesSalvas] = useState([])
  const [salvando, setSalvando] = useState(false)
  const [salvandoSim, setSalvandoSim] = useState(false)
  const [carregandoSims, setCarregandoSims] = useState(false)
  const [simForm, setSimForm] = useState({ titulo: '', cliente: '', descricao: '', data_carga: new Date().toISOString().slice(0, 10) })
  const [simulacaoCarregadaId, setSimulacaoCarregadaId] = useState(null)
  const [novoItem, setNovoItem] = useState({
    titulo: 'Lote manual',
    largura: '1.20',
    comprimento: '1.00',
    altura: '1.40',
    quantidade: '1',
  })
  const [novoItemErro, setNovoItemErro] = useState('')
  const [modoManual, setModoManual] = useState('livre') // 'livre' | 'cadastrado'
  const [novoItemPaleteSel, setNovoItemPaleteSel] = useState('') // "ferramenta|comprimento_mm"
  const [romaneioPaletes, setRomaneioPaletes] = useState([])
  const [romaneioLoading, setRomaneioLoading] = useState(false)
  const [romaneioErro, setRomaneioErro] = useState('')
  const [romaneioFiltroStatus, setRomaneioFiltroStatus] = useState('conferido')
  const [romaneioFiltroBusca, setRomaneioFiltroBusca] = useState('')
  const [romaneioFiltroNumero, setRomaneioFiltroNumero] = useState('') // filtro por número de romaneio
  const [romaneioModoSelecao, setRomaneioModoSelecao] = useState('rack') // 'rack' | 'romaneio' | 'cliente' | 'pedido'
  const [romaneioSelecionados, setRomaneioSelecionados] = useState(new Set()) // keys selecionados
  const [romaneioDimensoes, setRomaneioDimensoes] = useState({})
  const [romaneioDimensoesErro, setRomaneioDimensoesErro] = useState({})
  const [ferramentasCfgData, setFerramentasCfgData] = useState([])
  const [paleteConfigData, setPaleteConfigData] = useState([]) // configs de palete de todas as ferramentas
  const [racksEmCargas, setRacksEmCargas] = useState(new Set()) // racks já vinculados a cargas confirmadas
  const [secaoItensAberta, setSecaoItensAberta] = useState(true)
  const [secaoRomaneiOsAberta, setSecaoRomaneiOsAberta] = useState(true)
  const [secaoManualAberta, setSecaoManualAberta] = useState(false)

  const fetchRacksEmCargas = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('simulacao_cubagem_itens')
        .select('rack_nome, simulacoes_cubagem!inner(tipo, status)')
        .not('rack_nome', 'is', null)
      if (error) throw error
      const nomes = (data || [])
        .filter(d => d.simulacoes_cubagem?.tipo === 'carga' && ['confirmado', 'expedido'].includes(d.simulacoes_cubagem?.status))
        .map(d => String(d.rack_nome).toUpperCase().trim())
      setRacksEmCargas(new Set(nomes))
    } catch (e) { console.error('Erro ao buscar racks em cargas:', e) }
  }, [])

  const handleInteractiveMargem = useCallback((novoValorMm) => {
    setForm(prev => ({
      ...prev,
      ripas_lat_margem_mm: novoValorMm,
    }))
  }, [])

  const fetchRomaneiosDisponiveis = useCallback(async () => {
    if (!open) return
    setRomaneioLoading(true)
    setRomaneioErro('')
    try {
      const statusMap = {
        conferido: ['conferido'],
        expedido: ['expedido'],
        todos: ['conferido', 'expedido'],
      }
      const statuses = statusMap[romaneioFiltroStatus] || ['conferido']
      const { data: romaneiosLista, error: romaneiosError } = await supabase
        .from('expedicao_romaneios')
        .select('id, numero_romaneio, status, data_criacao, data_conferencia, data_expedicao, cliente')
        .in('status', statuses)
        .order('data_conferencia', { ascending: false })
        .limit(40)

      if (romaneiosError) throw romaneiosError
      if (!romaneiosLista?.length) {
        setRomaneioPaletes([])
        return
      }

      const romaneioMap = {}
      romaneiosLista.forEach((rom) => { romaneioMap[rom.id] = rom })
      const ids = romaneiosLista.map((rom) => rom.id)

      const { data: itens, error: itensError } = await supabase
        .from('expedicao_romaneio_itens')
        .select('id, romaneio_id, rack_ou_pallet, produto, quantidade, cliente, pedido_seq, lote_externo, status_item, comprimento_acabado_mm')
        .in('romaneio_id', ids)
        .order('romaneio_id', { ascending: false })

      if (itensError) throw itensError

      const itensConferidos = (itens || []).filter((item) => item.status_item === 'conferido')
      const grupos = agruparRomaneioItens(itensConferidos, romaneioMap)
      setRomaneioPaletes(grupos)
    } catch (error) {
      console.error('Erro ao carregar romaneios para cubagem:', error)
      setRomaneioErro(error.message || 'Não foi possível carregar romaneios disponíveis.')
      setRomaneioPaletes([])
    } finally {
      setRomaneioLoading(false)
    }
  }, [open, romaneioFiltroStatus])

  useEffect(() => {
    if (!open || !ferramenta) return
    fetchConfig()
  }, [open, ferramenta, comprimento])

  useEffect(() => {
    if (!open || (activeTab !== 'cubagem' && activeTab !== 'validacao')) return
    if (activeTab === 'cubagem') {
      fetchRomaneiosDisponiveis()
      fetchRacksEmCargas()
    }
    // Carregar ferramentas_cfg para ter pecas_por_amarrado / pcs_por_pallet
    supabase.from('ferramentas_cfg').select('ferramenta, comprimento_mm, pecas_por_amarrado, pcs_por_pallet, pcs_por_caixa, embalagem')
      .then(({ data }) => { if (data) setFerramentasCfgData(data) })
    // Carregar palete_config de todas as ferramentas para calcular dimensões corretas por item
    supabase.from('palete_config').select('ferramenta, comprimento_mm, largura_pacote_mm, altura_pacote_mm, profundidade_pacote_mm, pacotes_por_camada, camadas_por_bloco, num_blocos, orientacao_pacote, ripa_vertical, ripa_vert_largura_mm, ripa_vert_comp_mm, ripa_entre_camadas, ripa_altura_mm, ripa_topo')
      .then(({ data }) => { if (data) setPaleteConfigData(data) })
  }, [open, activeTab, fetchRomaneiosDisponiveis])

  const fetchConfig = async () => {
    setLoading(true)
    setMsg('')
    
    // Converter comprimento para número ou null
    const comprimentoNum = comprimento ? parseInt(comprimento, 10) : null
    
    // Buscar configuração específica (ferramenta + comprimento)
    let { data, error } = await supabase
      .from('palete_config')
      .select('*')
      .eq('ferramenta', ferramenta)
      .eq('comprimento_mm', comprimentoNum)
      .maybeSingle()
    
    // Se não encontrar específica, buscar genérica (apenas ferramenta, comprimento null)
    if (!data && !error) {
      const { data: dataGenerica } = await supabase
        .from('palete_config')
        .select('*')
        .eq('ferramenta', ferramenta)
        .is('comprimento_mm', null)
        .maybeSingle()
      data = dataGenerica
    }

    if (data) {
      const colunasRot = parseColunasRotacionadas(data.colunas_rotacionadas, data.pacotes_por_camada ?? 0)
      const configNormalizado = { ...data, colunas_rotacionadas: colunasRot }
      setConfig(configNormalizado)
      setForm({
        // Palete
        tipo_palete:           data.tipo_palete           ?? 'PBR_1200x1000',
        pacotes_por_camada:    data.pacotes_por_camada    ?? 3,
        camadas_por_bloco:     data.camadas_por_bloco     ?? 3,
        num_blocos:            data.num_blocos            ?? 3,
        // Ripas entre camadas
        ripa_entre_camadas:    data.ripa_entre_camadas    ?? true,
        num_ripas_por_camada:  data.num_ripas_por_camada  ?? 3,
        ripas_entre_posicao:   data.ripas_entre_posicao   ?? 'uniforme',
        ripas_entre_offset_mm: data.ripas_entre_offset_mm ?? 0,
        ripas_entre_manual:    data.ripas_entre_manual    ?? false,
        ripas_entre_posicoes:  data.ripas_entre_posicoes  ?? '',
        ripa_altura_mm:        data.ripa_altura_mm        ?? 17,
        ripa_largura_mm:       data.ripa_largura_mm       ?? 75,
        ripa_comprimento_mm: data.ripa_comprimento_mm   ?? 1200,
        ripa_topo:             data.ripa_topo             ?? true,
        // Camada final
        camada_final_ativa:    data.camada_final_ativa    ?? false,
        camada_final_qtd:      data.camada_final_qtd      ?? 1,
        camada_final_posicao:  data.camada_final_posicao  ?? 'centralizada',
        // Multi-pilha
        multi_pilha_ativa:     data.multi_pilha_ativa     ?? false,
        multi_pilha_qtd:       data.multi_pilha_qtd       ?? 1,
        multi_pilha_folga_mm:  data.multi_pilha_folga_mm  ?? 50,
        // Ripas laterais
        ripa_vertical:         data.ripa_vertical         ?? true,
        num_ripas_lateral:     data.num_ripas_lateral     ?? 3,
        ripas_lat_posicao:     data.ripas_lat_posicao     ?? 'uniforme',
        ripas_lat_offset_mm:   data.ripas_lat_offset_mm   ?? 0,
        ripas_lat_manual:      data.ripas_lat_manual      ?? false,
        ripas_lat_posicoes:    data.ripas_lat_posicoes    ?? '',
        ripas_lat_margem_mm:   data.ripas_lat_margem_mm   ?? 40,
        ripa_vert_largura_mm:  data.ripa_vert_largura_mm  ?? 17,
        ripa_vert_comp_mm:     data.ripa_vert_comp_mm     ?? 75,
        ripa_vert_altura_mm:   data.ripa_vert_altura_mm   ?? 1080,
        // Pacote
        largura_pacote_mm:     data.largura_pacote_mm     ?? 300,
        altura_pacote_mm:      data.altura_pacote_mm      ?? 100,
        profundidade_pacote_mm: data.profundidade_pacote_mm ?? 6000,
        orientacao_pacote:     data.orientacao_pacote     ?? 'longitudinal',
        cor_pacote:            data.cor_pacote            ?? '#b0b8c1',
        colunas_rotacionadas:  colunasRot,
        descricao_montagem:    data.descricao_montagem    ?? '',
        mostrar_cotas:         data.mostrar_cotas         ?? true,
        peso_pacote_kg:        data.peso_pacote_kg        ?? '',
      })
    } else {
      setConfig(null)
      setMsg('Nenhuma configuração cadastrada para esta ferramenta.')
    }
    setLoading(false)
  }

  const handleSalvar = async () => {
    setSalvando(true)
    setMsg('')
    const comprimentoNum = comprimento ? parseInt(comprimento, 10) : null
    const payload = {
      ferramenta,
      comprimento_mm:        comprimentoNum,
      // Palete
      tipo_palete:           form.tipo_palete,
      pacotes_por_camada:    Number(form.pacotes_por_camada),
      camadas_por_bloco:     Number(form.camadas_por_bloco),
      num_blocos:            Number(form.num_blocos),
      // Ripas entre camadas
      ripa_entre_camadas:    form.ripa_entre_camadas,
      num_ripas_por_camada:  Number(form.num_ripas_por_camada),
      ripas_entre_posicao:   form.ripas_entre_posicao,
      ripas_entre_offset_mm: Number(form.ripas_entre_offset_mm),
      ripas_entre_manual:    form.ripas_entre_manual,
      ripas_entre_posicoes:  form.ripas_entre_posicoes,
      ripa_altura_mm:        Number(form.ripa_altura_mm),
      ripa_largura_mm:       Number(form.ripa_largura_mm),
      ripa_comprimento_mm:   Number(form.ripa_comprimento_mm),
      ripa_topo:             form.ripa_topo,
      // Camada final
      camada_final_ativa:    form.camada_final_ativa,
      camada_final_qtd:      Number(form.camada_final_qtd),
      camada_final_posicao:  form.camada_final_posicao,
      // Multi-pilha
      multi_pilha_ativa:     form.multi_pilha_ativa,
      multi_pilha_qtd:       Number(form.multi_pilha_qtd) || 1,
      multi_pilha_folga_mm:  Number(form.multi_pilha_folga_mm) || 50,
      // Visualização
      mostrar_cotas:         form.mostrar_cotas,
      peso_pacote_kg:        form.peso_pacote_kg !== '' ? Number(form.peso_pacote_kg) : null,
      // Ripas laterais
      ripa_vertical:         form.ripa_vertical,
      num_ripas_lateral:     Number(form.num_ripas_lateral),
      ripas_lat_posicao:     form.ripas_lat_posicao,
      ripas_lat_offset_mm:   Number(form.ripas_lat_offset_mm),
      ripas_lat_manual:      form.ripas_lat_manual,
      ripas_lat_posicoes:    form.ripas_lat_posicoes,
      ripas_lat_margem_mm:   Number(form.ripas_lat_margem_mm),
      ripa_vert_largura_mm:  Number(form.ripa_vert_largura_mm),
      ripa_vert_comp_mm:     Number(form.ripa_vert_comp_mm),
      ripa_vert_altura_mm:   Number(form.ripa_vert_altura_mm),
      // Pacote
      largura_pacote_mm:     Number(form.largura_pacote_mm),
      altura_pacote_mm:      Number(form.altura_pacote_mm),
      profundidade_pacote_mm: Number(form.profundidade_pacote_mm),
      orientacao_pacote:     form.orientacao_pacote,
      cor_pacote:            form.cor_pacote,
      colunas_rotacionadas:  form.colunas_rotacionadas,
      descricao_montagem:    form.descricao_montagem,
      updated_at:            new Date().toISOString(),
    }

    const { error } = await supabase
      .from('palete_config')
      .upsert(payload, { onConflict: 'ferramenta,comprimento_mm' })

    if (error) {
      setMsg('Erro ao salvar: ' + error.message)
    } else {
      setMsg('Configuração salva com sucesso!')
      setEditando(false)
      fetchConfig()
    }
    setSalvando(false)
  }

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target
    if (name === 'pacotes_por_camada') {
      const numerico = Number(value)
      setForm(prev => ({
        ...prev,
        [name]: value,
        colunas_rotacionadas: Number.isFinite(numerico)
          ? Array.from({ length: Math.max(0, numerico) }, () => false)
          : prev.colunas_rotacionadas,
      }))
      return
    }

    // Validar comprimento das ripas entre camadas (apenas aviso, não bloqueia)
    if (name === 'ripa_comprimento_mm') {
      const comprimentoDigitado = Number(value) || 0
      // Calcular largura do material empilhado (sem ripas laterais)
      const pkLarg = mmToM(form.largura_pacote_mm || 300)
      const pkProf = mmToM(form.profundidade_pacote_mm || 6000)
      const layoutTemp = calcularLayoutColunas({
        pacotesPorCamada: Math.max(1, Number(form.pacotes_por_camada) || 3),
        orientacaoPacote: form.orientacao_pacote || 'longitudinal',
        pkLargX: pkLarg,
        pkProfZ: pkProf,
        gap: 0.01,
        colunasRotacionadas: form.colunas_rotacionadas,
      })
      // Largura apenas do material (sem margens das ripas verticais)
      const larguraMaterial = layoutTemp.spanX * 1000
      if (comprimentoDigitado > 0 && comprimentoDigitado < larguraMaterial) {
        // Aviso informativo apenas, não bloqueia
        console.log(`Aviso: Comprimento ${comprimentoDigitado}mm é menor que a largura do material (${Math.round(larguraMaterial)}mm)`)
      }
    }

    setForm(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }))
  }

  const handleCancelar = () => {
    setEditando(false)
    setMsg('')
    if (config) {
      setForm({
        // Palete
        tipo_palete:           config.tipo_palete           ?? 'PBR_1200x1000',
        pacotes_por_camada:    config.pacotes_por_camada    ?? 3,
        camadas_por_bloco:     config.camadas_por_bloco     ?? 3,
        num_blocos:            config.num_blocos            ?? 3,
        // Ripas entre camadas
        ripa_entre_camadas:    config.ripa_entre_camadas    ?? true,
        num_ripas_por_camada:  config.num_ripas_por_camada  ?? 3,
        ripas_entre_posicao:   config.ripas_entre_posicao   ?? 'uniforme',
        ripas_entre_offset_mm: config.ripas_entre_offset_mm ?? 0,
        ripas_entre_manual:    config.ripas_entre_manual    ?? false,
        ripas_entre_posicoes:  config.ripas_entre_posicoes  ?? '',
        ripa_altura_mm:        config.ripa_altura_mm        ?? 17,
        ripa_largura_mm:       config.ripa_largura_mm       ?? 75,
        ripa_comprimento_mm:   config.ripa_comprimento_mm   ?? 1200,
        ripa_topo:             config.ripa_topo             ?? true,
        // Camada final
        camada_final_ativa:    config.camada_final_ativa    ?? false,
        camada_final_qtd:      config.camada_final_qtd      ?? 1,
        camada_final_posicao:  config.camada_final_posicao  ?? 'centralizada',
        // Multi-pilha
        multi_pilha_ativa:     config.multi_pilha_ativa     ?? false,
        multi_pilha_qtd:       config.multi_pilha_qtd       ?? 1,
        multi_pilha_folga_mm:  config.multi_pilha_folga_mm  ?? 50,
        // Ripas laterais
        ripa_vertical:         config.ripa_vertical         ?? true,
        num_ripas_lateral:     config.num_ripas_lateral     ?? 3,
        ripas_lat_posicao:     config.ripas_lat_posicao     ?? 'uniforme',
        ripas_lat_offset_mm:   config.ripas_lat_offset_mm   ?? 0,
        ripas_lat_manual:      config.ripas_lat_manual      ?? false,
        ripas_lat_posicoes:    config.ripas_lat_posicoes    ?? '',
        ripas_lat_margem_mm:   config.ripas_lat_margem_mm   ?? 40,
        ripa_vert_largura_mm:  config.ripa_vert_largura_mm  ?? 17,
        ripa_vert_comp_mm:     config.ripa_vert_comp_mm     ?? 75,
        // Pacote
        largura_pacote_mm:     config.largura_pacote_mm     ?? 300,
        altura_pacote_mm:      config.altura_pacote_mm      ?? 100,
        profundidade_pacote_mm: config.profundidade_pacote_mm ?? 6000,
        orientacao_pacote:     config.orientacao_pacote     ?? 'longitudinal',
        cor_pacote:            config.cor_pacote            ?? '#b0b8c1',
        colunas_rotacionadas:  config.colunas_rotacionadas ?? [],
        descricao_montagem:    config.descricao_montagem    ?? '',
        mostrar_cotas:         config.mostrar_cotas         ?? true,
        peso_pacote_kg:        config.peso_pacote_kg        ?? '',
      })
    }
  }

  const metricsPaleteAtual = useMemo(() => {
    const pacotesCamada = Math.max(1, Number(form.pacotes_por_camada) || 0)
    const camadasPorBloco = Math.max(1, Number(form.camadas_por_bloco) || 1)
    const numBlocosAtivos = Math.max(1, Number(form.num_blocos) || 1)
    const pkLarg = mmToM(form.largura_pacote_mm)
    const pkProf = mmToM(form.profundidade_pacote_mm)
    const pkAlt = mmToM(form.altura_pacote_mm)
    if (pkLarg <= 0 || pkProf <= 0 || pkAlt <= 0) return null

    const layout = calcularLayoutColunas({
      pacotesPorCamada: pacotesCamada,
      orientacaoPacote: form.orientacao_pacote || 'longitudinal',
      pkLargX: pkLarg,
      pkProfZ: pkProf,
      gap: 0.01,
      colunasRotacionadas: form.colunas_rotacionadas,
    })

    const ripaAlt = mmToM(form.ripa_altura_mm)
    const altCamada = pkAlt + 0.004
    const altRipaBloco = form.ripa_entre_camadas ? ripaAlt + 0.004 : 0.006
    const altBlocoTotal = altRipaBloco + camadasPorBloco * altCamada
    const altEmpilhado = numBlocosAtivos * altBlocoTotal + (form.ripa_topo ? ripaAlt + 0.004 : 0)
    const totalAlt = 0.112 + altEmpilhado
    // Dimensões reais do palete (SEM ripas laterais - são estruturais, não aumentam pegada)
    const totalLarg = layout.spanX  // Comprimento real do material
    const totalProf = layout.spanZ   // Largura real do material
    const totalPacotes = pacotesCamada * camadasPorBloco * numBlocosAtivos
    const volume = totalLarg * totalProf * totalAlt

    return {
      spanX: layout.spanX,
      spanZ: layout.spanZ,
      totalLarg,
      totalProf,
      totalAlt,
      totalPacotes,
      volume,
      layout,
      camadasPorBloco,
      numBlocos: numBlocosAtivos,
      pacotesPorCamada: pacotesCamada,
      pesoPacoteKg: Number(form.peso_pacote_kg) || 0,
    }
  }, [
    form.pacotes_por_camada,
    form.camadas_por_bloco,
    form.num_blocos,
    form.largura_pacote_mm,
    form.profundidade_pacote_mm,
    form.altura_pacote_mm,
    form.orientacao_pacote,
    form.colunas_rotacionadas,
    form.ripa_altura_mm,
    form.ripa_entre_camadas,
    form.ripa_topo,
    form.ripa_vertical,
    form.ripa_vert_largura_mm,
    form.ripa_vert_comp_mm,
    form.peso_pacote_kg,
  ])

  // Sugestão automática de multi-pilha: calcula quantas pilhas cabem no palete
  const multiPilhaSugestao = useMemo(() => {
    // Dimensões do palete (em mm) baseado no tipo
    const paleteDims = {
      'PBR_1000x1000': { largX: 1000, profZ: 1000 },
      'PBR_1200x1200': { largX: 1200, profZ: 1200 },
      'PBR_1200x800':  { largX: 1200, profZ: 800 },
      'PBR_1200x1000': { largX: 1200, profZ: 1000 },
    }
    const dims = paleteDims[form.tipo_palete] || paleteDims['PBR_1200x1000']
    const compMaterial = Number(form.profundidade_pacote_mm) || 0
    const folga = Number(form.multi_pilha_folga_mm) || 50
    const orientacao = form.orientacao_pacote || 'longitudinal'

    // Material corre ao longo do eixo do "comprimento"
    // Longitudinal: comprimento = eixo Z do palete
    // Transversal:  comprimento = eixo X do palete
    const eixoPalete = orientacao === 'transversal' ? dims.largX : dims.profZ
    const nomeEixo = orientacao === 'transversal' ? 'X (largura do palete)' : 'Z (profundidade do palete)'

    if (compMaterial <= 0 || compMaterial >= eixoPalete) {
      return { qtd: 1, eixoPalete, compMaterial, folga, nomeEixo, cabe: false }
    }
    const qtd = Math.max(1, Math.floor(eixoPalete / (compMaterial + folga)))
    return { qtd, eixoPalete, compMaterial, folga, nomeEixo, cabe: qtd > 1 }
  }, [form.tipo_palete, form.profundidade_pacote_mm, form.multi_pilha_folga_mm, form.orientacao_pacote])

  const itemBaseConfigurado = useMemo(() => {
    if (!metricsPaleteAtual) return null
    return montarItemSimulacao(metricsPaleteAtual)
  }, [metricsPaleteAtual])

  const dimensoesPadraoRomaneio = useMemo(() => {
    if (!itemBaseConfigurado) return { largura: '', comprimento: '', altura: '' }
    const formatar = (valor) => (typeof valor === 'number' && Number.isFinite(valor) ? valor.toFixed(2) : '')
    return {
      largura: formatar(itemBaseConfigurado.largura),
      comprimento: formatar(itemBaseConfigurado.comprimento),
      altura: formatar(itemBaseConfigurado.altura),
    }
  }, [itemBaseConfigurado])

  // Calcula completude e altura proporcional para paletes parciais
  const calcularCompletudePalete = useCallback((entrada) => {
    if (!entrada || !metricsPaleteAtual) return null
    const produto = entrada.produtos?.[0] || ''
    if (!produto) return null

    // Extrair ferramenta do código do produto (ex: TR0018171420NANI → TR-0018)
    const s = String(produto).toUpperCase()
    const m3 = s.match(/^([A-Z]{3})([A-Z0-9]+)/)
    const m2 = s.match(/^([A-Z]{2})([A-Z0-9]+)/)
    const m = m3 || m2
    if (!m) return null
    const letras = m[1], resto = m[2], qtdDig = m3 ? 3 : 4
    let nums = ''
    for (const ch of resto) {
      if (/[0-9]/.test(ch)) nums += ch
      else if (ch === 'O') nums += '0'
      if (nums.length === qtdDig) break
    }
    if (nums.length < qtdDig) nums = nums.padEnd(qtdDig, '0')
    const ferr = `${letras}-${nums}`

    // Buscar config da ferramenta
    const compMm = entrada.comprimentoAcabadoMm || 0
    const cfg = ferramentasCfgData.find(c => {
      if (String(c?.ferramenta || '').toUpperCase() !== ferr) return false
      if (!compMm) return true
      const cc = Number(c?.comprimento_mm || 0)
      return cc ? cc === compMm : true
    })
    if (!cfg) return null

    const porAmarrado = Number(cfg.pecas_por_amarrado || 0)
    const pcsPalete = Number(cfg.embalagem === 'caixa' ? cfg.pcs_por_caixa : cfg.pcs_por_pallet) || 0
    if (porAmarrado <= 0 || pcsPalete <= 0) return null

    const pecasRack = entrada.quantidadePecas || 0
    const amarradosRack = pecasRack / porAmarrado
    const amarradosPalete = pcsPalete / porAmarrado

    // Dados da estrutura do palete
    const pacotesPorCamada = metricsPaleteAtual.pacotesPorCamada || 1
    const camadasPorBloco = metricsPaleteAtual.camadasPorBloco || 1
    const numBlocos = metricsPaleteAtual.numBlocos || 1
    const totalPacotesPalete = pacotesPorCamada * camadasPorBloco * numBlocos

    // Usar o menor entre amarrados padrão e pacotes do 3D como referência
    const refTotal = Math.max(amarradosPalete, totalPacotesPalete)
    const completude = Math.min(1, amarradosRack / refTotal)

    // Calcular altura proporcional: quantas camadas reais o rack preenche
    const camadasNecessarias = Math.ceil(amarradosRack / pacotesPorCamada)
    const totalCamadas = camadasPorBloco * numBlocos
    const camadasReais = Math.min(camadasNecessarias, totalCamadas)

    // Altura: base palete (0.112m) + proporcional das camadas
    const altPadrao = metricsPaleteAtual.totalAlt // altura total do palete completo
    const altBase = 0.112 // altura do palete base PBR
    const altEmpilhado = altPadrao - altBase
    const altProporcional = altBase + (altEmpilhado * (camadasReais / totalCamadas))

    return {
      completude,
      percentual: Math.round(completude * 100),
      amarradosRack: Math.floor(amarradosRack),
      sobraPecas: Math.round(pecasRack % porAmarrado),
      amarradosPalete: Math.round(amarradosPalete),
      porAmarrado,
      alturaEstimada: altProporcional,
      completo: completude >= 0.99,
    }
  }, [metricsPaleteAtual, ferramentasCfgData])

  // Calcula dimensões do palete a partir de uma config do banco
  // Usa calcularDimensoesPalete (fonte única de verdade) para consistência entre abas
  const calcularDimensoesDaConfig = useCallback((cfg) => {
    const dims = calcularDimensoesPalete(cfg)
    if (!dims) return null
    // comprimento = maior dimensão horizontal (sempre o comprimento físico do material)
    // largura     = menor dimensão horizontal (extensão lateral do palete)
    const horiz1 = dims.larguraM    // spanX
    const horiz2 = dims.comprimentoM // spanZ
    return {
      largura: Math.min(horiz1, horiz2).toFixed(2),
      comprimento: Math.max(horiz1, horiz2).toFixed(2),
      altura: dims.alturaM.toFixed(2),
    }
  }, [])

  // Busca a melhor config de palete para uma ferramenta+comprimento
  const buscarPaleteConfig = useCallback((ferrNorm, compMm) => {
    if (!paleteConfigData.length) return null
    // Busca específica: ferramenta + comprimento_mm exato
    const especifica = paleteConfigData.find(c =>
      String(c.ferramenta || '').toUpperCase() === ferrNorm &&
      Number(c.comprimento_mm) === compMm
    )
    if (especifica) return especifica
    // Fallback: apenas ferramenta (comprimento_mm null)
    return paleteConfigData.find(c =>
      String(c.ferramenta || '').toUpperCase() === ferrNorm &&
      !c.comprimento_mm
    ) || null
  }, [paleteConfigData])

  useEffect(() => {
    setRomaneioDimensoes(prev => {
      const atuais = new Set(romaneioPaletes.map(entry => entry.key))
      let mudou = false
      const atualizado = {}

      romaneioPaletes.forEach((entry) => {
        const compRealM = entry.comprimentoAcabadoMm > 0
          ? (entry.comprimentoAcabadoMm / 1000).toFixed(2)
          : null

        // Calcular altura estimada baseada na completude do palete
        const completudeInfo = calcularCompletudePalete(entry)
        const alturaEstimada = completudeInfo?.alturaEstimada
          ? completudeInfo.alturaEstimada.toFixed(2)
          : null

        // Extrair ferramenta e comprimento do próprio item para buscar config correta
        const produto = entry.produtos?.[0] || ''
        const sP = String(produto).toUpperCase()
        const mP3 = sP.match(/^([A-Z]{3})([A-Z0-9]+)/)
        const mP2 = sP.match(/^([A-Z]{2})([A-Z0-9]+)/)
        const mP = mP3 || mP2
        let dimsDoItem = null
        if (mP) {
          const letras = mP[1], resto = mP[2], qtdDig = mP3 ? 3 : 4
          let nums = ''
          for (const ch of resto) {
            if (/[0-9]/.test(ch)) nums += ch
            else if (ch === 'O') nums += '0'
            if (nums.length === qtdDig) break
          }
          if (nums.length < qtdDig) nums = nums.padEnd(qtdDig, '0')
          const ferrItem = `${letras}-${nums}`
          const compItem = entry.comprimentoAcabadoMm || 0
          const cfgItem = buscarPaleteConfig(ferrItem, compItem)
          dimsDoItem = calcularDimensoesDaConfig(cfgItem)
        }

        // Fallback para a config da ferramenta carregada na tela
        const dimsFallback = dimensoesPadraoRomaneio

        if (prev[entry.key]) {
          // Já existe — preservar largura e quantidade editadas pelo usuário
          // mas sempre corrigir o comprimento se o material tem comprimento real
          const prevComp = prev[entry.key].comprimento
          const deveCorrigirComp = compRealM && prevComp !== compRealM
          if (deveCorrigirComp) {
            atualizado[entry.key] = { ...prev[entry.key], comprimento: compRealM }
            mudou = true
          } else {
            atualizado[entry.key] = prev[entry.key]
          }
        } else {
          // Novo entry — usar dimensões da config do próprio item, com fallback para config atual
          atualizado[entry.key] = {
            largura: dimsDoItem?.largura || dimsFallback.largura || '',
            comprimento: compRealM || dimsDoItem?.comprimento || dimsFallback.comprimento || '',
            altura: alturaEstimada || dimsDoItem?.altura || dimsFallback.altura || '',
            quantidade: '1',
          }
          mudou = true
        }
      })

      Object.keys(prev).forEach((key) => {
        if (!atuais.has(key)) mudou = true
      })

      return mudou ? atualizado : prev
    })

    setRomaneioDimensoesErro(prev => {
      const atuais = new Set(romaneioPaletes.map(entry => entry.key))
      let mudou = false
      const atualizado = {}
      Object.entries(prev).forEach(([key, valor]) => {
        if (atuais.has(key)) {
          atualizado[key] = valor
        } else {
          mudou = true
        }
      })
      return mudou ? atualizado : prev
    })
  }, [romaneioPaletes, dimensoesPadraoRomaneio, calcularCompletudePalete, paleteConfigData, buscarPaleteConfig, calcularDimensoesDaConfig])

  // Corrigir itens já na fila que foram adicionados com comprimento incorreto
  useEffect(() => {
    if (!romaneioPaletes.length) return
    setFilaItens(prev => {
      let mudou = false
      const atualizados = prev.map(item => {
        if (item.origem !== 'romaneio' || !item.metadataRomaneio?.key) return item
        const entrada = romaneioPaletes.find(e => e.key === item.metadataRomaneio.key)
        if (!entrada || !entrada.comprimentoAcabadoMm) return item
        const compRealM = entrada.comprimentoAcabadoMm / 1000
        if (Math.abs(item.comprimento - compRealM) < 0.001) return item
        mudou = true
        return {
          ...item,
          comprimento: compRealM,
          volume: item.largura * compRealM * item.altura,
        }
      })
      return mudou ? atualizados : prev
    })
  }, [romaneioPaletes])

  // Lista única de números de romaneio para o dropdown (com cliente)
  const romaneioNumerosUnicos = useMemo(() => {
    const mapa = new Map()
    romaneioPaletes.forEach(e => {
      if (e.romaneioNumero && !mapa.has(e.romaneioNumero)) {
        const cliente = e.romaneioCliente || (e.clientes?.[0]) || '—'
        mapa.set(e.romaneioNumero, { numero: e.romaneioNumero, cliente })
      }
    })
    return Array.from(mapa.values()).sort((a, b) => a.numero.localeCompare(b.numero))
  }, [romaneioPaletes])

  const romaneioPaletesFiltrados = useMemo(() => {
    const termo = romaneioFiltroBusca.trim().toLowerCase()
    return romaneioPaletes.filter((entrada) => {
      // Excluir racks já vinculados a uma carga confirmada
      if (racksEmCargas.has(String(entrada.rack).toUpperCase().trim())) return false
      // Filtro por número de romaneio
      if (romaneioFiltroNumero && entrada.romaneioNumero !== romaneioFiltroNumero) return false
      if (!termo) return true
      const alvo = [
        entrada.rack,
        entrada.romaneioNumero,
        entrada.romaneioStatus,
        entrada.romaneioCliente,
        entrada.clientes.join(' '),
        entrada.produtos.join(' '),
        entrada.pedidos.join(' '),
      ].join(' ').toLowerCase()
      return alvo.includes(termo)
    })
  }, [romaneioPaletes, romaneioFiltroBusca, romaneioFiltroNumero, racksEmCargas])

  // Agrupar por diferentes critérios para seleção em massa
  const romaneioAgrupado = useMemo(() => {
    const grupos = {}
    romaneioPaletesFiltrados.forEach(entrada => {
      let chave
      switch (romaneioModoSelecao) {
        case 'romaneio':
          chave = `romaneio:${entrada.romaneioNumero}`
          break
        case 'cliente':
          chave = `cliente:${entrada.romaneioCliente || entrada.clientes[0] || 'sem-cliente'}`
          break
        case 'pedido':
          chave = `pedido:${entrada.pedidos[0] || 'sem-pedido'}`
          break
        case 'rack':
        default:
          chave = entrada.key
      }
      if (!grupos[chave]) grupos[chave] = []
      grupos[chave].push(entrada)
    })
    return grupos
  }, [romaneioPaletesFiltrados, romaneioModoSelecao])

  // Selecionar/desselecionar todos visíveis
  const toggleSelecionarTodos = () => {
    const todosSelecionados = romaneioPaletesFiltrados.every(e => romaneioSelecionados.has(e.key))
    setRomaneioSelecionados(prev => {
      const novo = new Set(prev)
      romaneioPaletesFiltrados.forEach(e => {
        if (todosSelecionados) {
          novo.delete(e.key)
        } else {
          novo.add(e.key)
        }
      })
      return novo
    })
  }

  // Selecionar/desselecionar grupo (quando modo não é 'rack')
  const toggleSelecionarGrupo = (chaveGrupo) => {
    const itensGrupo = romaneioAgrupado[chaveGrupo] || []
    const todosSelecionados = itensGrupo.every(e => romaneioSelecionados.has(e.key))
    setRomaneioSelecionados(prev => {
      const novo = new Set(prev)
      itensGrupo.forEach(e => {
        if (todosSelecionados) {
          novo.delete(e.key)
        } else {
          novo.add(e.key)
        }
      })
      return novo
    })
  }

  // Adicionar todos selecionados à fila
  const adicionarSelecionados = () => {
    const selecionados = romaneioPaletesFiltrados.filter(e => romaneioSelecionados.has(e.key))
    selecionados.forEach(entrada => {
      if (!filaItens.some(item => item.metadataRomaneio?.key === entrada.key)) {
        handleAdicionarRomaneioPalete(entrada)
      }
    })
    setRomaneioSelecionados(new Set())
  }

  const totalCamadasPlanejadas = metricsPaleteAtual
    ? metricsPaleteAtual.camadasPorBloco * metricsPaleteAtual.numBlocos
    : (Number(form.camadas_por_bloco) || 0) * (Number(form.num_blocos) || 0)

  // Responsividade
  const screen = useResponsive()
  const classes = getResponsiveClasses(screen.isCompact)
  const [sidebarOpen, setSidebarOpen] = useState(!screen.isCompact)

  useEffect(() => {
    if (!itemBaseConfigurado) return
    setFilaItens(prev => {
      const snapshot = { ...itemBaseConfigurado, quantidade: itemBaseConfigurado.quantidade || 1 }
      if (!prev.length) {
        return [{ ...snapshot, id: gerarId(), origem: 'config_atual' }]
      }

      let encontrou = false
      let alterado = false
      const atualizado = prev.map(item => {
        if (item.origem !== 'config_atual') return item
        encontrou = true
        const proximo = {
          ...item,
          ...snapshot,
          quantidade: item.quantidade,
        }
        if (
          proximo.largura !== item.largura ||
          proximo.comprimento !== item.comprimento ||
          proximo.altura !== item.altura ||
          proximo.volume !== item.volume ||
          proximo.subtitulo !== item.subtitulo ||
          proximo.pesoPacoteKg !== item.pesoPacoteKg ||
          proximo.totalPacotes !== item.totalPacotes
        ) {
          alterado = true
          return proximo
        }
        return item
      })

      if (!encontrou) {
        return [...prev, { ...snapshot, id: gerarId(), origem: 'config_atual' }]
      }

      return alterado ? atualizado : prev
    })
  }, [itemBaseConfigurado])

  useEffect(() => {
    if (!filaItens.length) {
      setItemSelecionadoId(null)
      return
    }
    if (!itemSelecionadoId || !filaItens.some(item => item.id === itemSelecionadoId)) {
      setItemSelecionadoId(filaItens[0].id)
    }
  }, [filaItens, itemSelecionadoId])

  useEffect(() => {
    if (!open) return
    setActiveTab('visualizacao')
  }, [open])

  const itemSelecionado = useMemo(() => {
    if (!filaItens.length) return null
    return filaItens.find(item => item.id === itemSelecionadoId) || filaItens[0]
  }, [filaItens, itemSelecionadoId])

  const caminhaoAtual = useMemo(() => {
    return CAMINHOES_SIMULACAO.find(cam => cam.id === caminhaoSelecionado) || CAMINHOES_SIMULACAO[0]
  }, [caminhaoSelecionado])

  const simulacaoAtual = useMemo(() => {
    if (!itemSelecionado || !caminhaoAtual) return null
    return calcularCapacidadeNoCaminhao(itemSelecionado, caminhaoAtual, {
      folgaPerimetroCm,
      folgaAlturaCm,
      considerarAltura,
    })
  }, [itemSelecionado, caminhaoAtual, folgaPerimetroCm, folgaAlturaCm, considerarAltura])

  const totalPaletesFila = useMemo(() => (
    filaItens.reduce((acc, item) => acc + (Number(item.quantidade) || 0), 0)
  ), [filaItens])

  const totalVolumeFila = useMemo(() => (
    filaItens.reduce((acc, item) => {
      const volumeUnitario = item.volume || ((item.largura || 0) * (item.comprimento || 0) * (item.altura || 0))
      return acc + volumeUnitario * (Number(item.quantidade) || 0)
    }, 0)
  ), [filaItens])

  const totalPesoCargaKg = useMemo(() => {
    const pesoPorPacote = Number(form.peso_pacote_kg) || 0
    if (!pesoPorPacote) return null
    const totalPacotesPorPalete = metricsPaleteAtual?.totalPacotes || 1
    return filaItens.reduce((acc, item) => {
      const pesoPorPacoteItem = Number(item.pesoPacoteKg) || pesoPorPacote
      
      // Se tem metadataRomaneio, usar número real de peças
      if (item.metadataRomaneio) {
        // Para romaneio: usar quantidadePecas (número real de peças)
        const numPecas = Number(item.quantidadePecas) || Number(item.quantidade) || 0
        return acc + numPecas * pesoPorPacoteItem
      } else {
        // Para itens manuais: quantidade é número de paletes
        const pacotesPorPalete = item.totalPacotes || totalPacotesPorPalete
        return acc + pacotesPorPalete * pesoPorPacoteItem * (Number(item.quantidade) || 0)
      }
    }, 0)
  }, [filaItens, form.peso_pacote_kg, metricsPaleteAtual])

  const viagensNecessarias = simulacaoAtual?.capacidadeTotal > 0
    ? Math.ceil(totalPaletesFila / simulacaoAtual.capacidadeTotal)
    : null

  const viagensItemSelecionado = simulacaoAtual?.capacidadeTotal > 0 && itemSelecionado
    ? Math.ceil((Number(itemSelecionado.quantidade) || 0) / simulacaoAtual.capacidadeTotal)
    : null

  const formatMetros = (valor, digits = 2) => (
    Number.isFinite(valor) ? `${valor.toFixed(digits)} m` : '—'
  )

  const formatVolume = (valor) => (
    Number.isFinite(valor) ? `${valor.toFixed(3)} m³` : '—'
  )

  // ─── SAVE / LOAD / EXPORT ────────────────────────────────────────────────────
  // Helper: encontrar romaneio_id de um placement via filaItens
  const getMetadataFromPlacement = useCallback((p) => {
    const filaItem = filaItens[p.itemIdx ?? -1]
    const meta = filaItem?.metadataRomaneio
    return {
      romaneio_id: meta?.romaneioId ? Number(meta.romaneioId) : null,
      rack_nome: p.titulo || filaItem?.titulo || null,
    }
  }, [filaItens])

  const salvarSimulacao = useCallback(async (tipoSave = 'simulacao') => {
    if (!simForm.titulo.trim()) return
    const isCarga = tipoSave === 'carga'
    setSalvandoSim(true)
    try {
      const cam = caminhaoAtual
      const { data: sim, error: errSim } = await supabase.from('simulacoes_cubagem').insert({
        titulo: simForm.titulo.trim(),
        descricao: simForm.descricao.trim() || null,
        cliente: simForm.cliente.trim() || null,
        data_carga: simForm.data_carga || new Date().toISOString().slice(0, 10),
        caminhao_id: cam.id,
        caminhao_titulo: cam.titulo,
        caminhao_comprimento: cam.comprimento,
        caminhao_largura: cam.largura,
        caminhao_altura: cam.altura,
        modo: modoCubagem,
        folga_perimetro_cm: Number(folgaPerimetroCm) || 0,
        folga_altura_cm: Number(folgaAlturaCm) || 0,
        considerar_altura: considerarAltura,
        total_paletes: manualPlacements.length || filaItens.reduce((a, i) => a + (Number(i.quantidade) || 0), 0),
        total_camadas: modoCubagem === 'manual' ? Math.max(1, ...manualPlacements.map(p => (p.camada || 0) + 1)) : 1,
        peso_estimado_kg: totalPesoCargaKg,
        tipo: tipoSave,
        status: isCarga ? 'confirmado' : 'rascunho',
      }).select().single()
      if (errSim) throw errSim

      // Salvar itens posicionados (com romaneio_id e rack_nome)
      const itensToInsert = modoCubagem === 'manual'
        ? manualPlacements.map((p, i) => {
            const meta = getMetadataFromPlacement(p)
            return {
              simulacao_id: sim.id,
              item_idx: p.itemIdx ?? 0,
              titulo: p.titulo,
              cor: p.cor,
              largura: p.w,
              profundidade: p.d,
              altura: p.alt,
              pos_x: p.x,
              pos_z: p.z,
              camada: p.camada || 0,
              y_calculado: p.yCalc || 0,
              ordem: i,
              romaneio_id: meta.romaneio_id,
              rack_nome: meta.rack_nome,
            }
          })
        : filaItens.flatMap((item, idx) => {
            const qtd = Number(item.quantidade) || 0
            const meta = item.metadataRomaneio
            return Array.from({ length: qtd }, (_, q) => ({
              simulacao_id: sim.id,
              item_idx: idx,
              titulo: item.titulo,
              cor: ITEM_COLORS[idx % ITEM_COLORS.length],
              largura: Number(item.comprimento) || 0,
              profundidade: Number(item.largura) || 0,
              altura: Number(item.altura) || 0,
              pos_x: 0, pos_z: 0, camada: 0, y_calculado: 0,
              ordem: q,
              romaneio_id: meta?.romaneioId ? Number(meta.romaneioId) : null,
              rack_nome: item.titulo || null,
            }))
          })

      if (itensToInsert.length > 0) {
        const { error: errItens } = await supabase.from('simulacao_cubagem_itens').insert(itensToInsert)
        if (errItens) throw errItens
      }

      setSimulacaoCarregadaId(sim.id)
      setShowSalvarModal(false)
      const label = isCarga ? `Carga nº ${sim.numero_carga}` : 'Simulação'
      setMsg(`${label} salva com sucesso!`)
      setTimeout(() => setMsg(''), 3000)

      if (isCarga) {
        // Limpar fila e placements — itens agora pertencem à carga
        setFilaItens([])
        setManualPlacements([])
        setLoadedPlacements(null)
        // Recarregar racks bloqueados e romaneios disponíveis
        fetchRacksEmCargas()
        fetchRomaneiosDisponiveis()
      }
    } catch (e) {
      console.error('Erro ao salvar:', e)
      setMsg('Erro ao salvar: ' + (e.message || ''))
    } finally { setSalvandoSim(false) }
  }, [simForm, caminhaoAtual, modoCubagem, folgaPerimetroCm, folgaAlturaCm, considerarAltura, manualPlacements, filaItens, totalPesoCargaKg, getMetadataFromPlacement, fetchRacksEmCargas, fetchRomaneiosDisponiveis])

  const carregarListaSimulacoes = useCallback(async () => {
    setCarregandoSims(true)
    try {
      const { data, error } = await supabase
        .from('simulacoes_cubagem')
        .select('*')
        .order('criado_em', { ascending: false })
        .limit(50)
      if (error) throw error
      setSimulacoesSalvas(data || [])
    } catch (e) { console.error(e) }
    finally { setCarregandoSims(false) }
  }, [])

  const carregarSimulacao = useCallback(async (simId) => {
    try {
      const { data: sim, error: errSim } = await supabase
        .from('simulacoes_cubagem')
        .select('*')
        .eq('id', simId)
        .single()
      if (errSim) throw errSim

      const { data: itens, error: errItens } = await supabase
        .from('simulacao_cubagem_itens')
        .select('*')
        .eq('simulacao_id', simId)
        .order('ordem')
      if (errItens) throw errItens

      // Restaurar estado
      const camFound = CAMINHOES_SIMULACAO.find(c => c.id === sim.caminhao_id)
      if (camFound) setCaminhaoSelecionado(camFound.id)
      setFolgaPerimetroCm(sim.folga_perimetro_cm ?? 10)
      setFolgaAlturaCm(sim.folga_altura_cm ?? 0)
      setConsiderarAltura(sim.considerar_altura ?? true)
      setModoCubagem(sim.modo || 'manual')

      // Reconstruir filaItens a partir dos itens salvos (agrupados por item_idx)
      if (itens?.length) {
        const gruposIdx = {}
        itens.forEach(it => {
          const idx = it.item_idx ?? 0
          if (!gruposIdx[idx]) {
            gruposIdx[idx] = {
              id: gerarId(),
              origem: it.romaneio_id ? 'romaneio' : 'manual',
              titulo: it.titulo || `Item ${idx + 1}`,
              subtitulo: it.rack_nome || '',
              comprimento: Number(it.largura) || 0,
              largura: Number(it.profundidade) || 0,
              altura: Number(it.altura) || 0,
              volume: (Number(it.largura) || 0) * (Number(it.profundidade) || 0) * (Number(it.altura) || 0),
              quantidade: 0,
              metadataRomaneio: it.romaneio_id ? { romaneioId: it.romaneio_id, key: `rom_${it.romaneio_id}_${it.rack_nome}` } : undefined,
            }
          }
          gruposIdx[idx].quantidade += 1
        })
        const filaRestaurada = Object.keys(gruposIdx)
          .sort((a, b) => Number(a) - Number(b))
          .map(idx => gruposIdx[idx])
        setFilaItens(filaRestaurada)
      }

      if (itens?.length) {
        if (sim.modo === 'manual') {
          const restored = itens.map(it => ({
            id: `loaded_${it.id}`,
            itemIdx: it.item_idx,
            titulo: it.titulo,
            cor: it.cor || ITEM_COLORS[it.item_idx % ITEM_COLORS.length],
            w: Number(it.largura),
            d: Number(it.profundidade),
            alt: Number(it.altura),
            x: Number(it.pos_x),
            z: Number(it.pos_z),
            camada: it.camada || 0,
            yCalc: Number(it.y_calculado) || 0,
          }))
          setLoadedPlacements(restored)
          setManualPlacements(restored)
        } else {
          // Modo automático: recalcular posições via packItensNoCaminhao
          const cam = CAMINHOES_SIMULACAO.find(c => c.id === sim.caminhao_id) || CAMINHOES_SIMULACAO[0]
          const filaParaPack = Object.values(
            itens.reduce((acc, it) => {
              const idx = it.item_idx ?? 0
              if (!acc[idx]) {
                acc[idx] = {
                  id: it.item_idx,
                  titulo: it.titulo || `Item ${idx + 1}`,
                  comprimento: Number(it.largura) || 0,
                  largura: Number(it.profundidade) || 0,
                  altura: Number(it.altura) || 0,
                  quantidade: 0,
                }
              }
              acc[idx].quantidade += 1
              return acc
            }, {})
          )
          const { boxes } = packItensNoCaminhao(filaParaPack, cam, {
            folgaPerimetroCm: sim.folga_perimetro_cm ?? 10,
            folgaAlturaCm: sim.folga_altura_cm ?? 0,
            considerarAltura: sim.considerar_altura ?? true,
          })
          // Extrair itemIdx da key "i{idx}u{u}k{n}"
          const restored = boxes.map((b, i) => {
            const m = String(b.key || '').match(/^i(\d+)/)
            const itemIdx = m ? Number(m[1]) : 0
            return {
              id: `auto_${i}`,
              itemIdx,
              titulo: b.itemTitulo || `Item ${i + 1}`,
              cor: b.cor || ITEM_COLORS[itemIdx % ITEM_COLORS.length],
              w: b.wReal,
              d: b.dReal,
              alt: b.hReal,
              x: b.xReal - b.wReal / 2,
              z: b.zReal - b.dReal / 2,
              camada: 0,
              yCalc: b.yReal - b.hReal / 2,
            }
          })
          setLoadedPlacements(restored)
          setManualPlacements(restored)
        }
      }

      setSimulacaoCarregadaId(sim.id)
      setShowCarregarModal(false)
      setMsg(`Simulação "${sim.titulo}" carregada!`)
      setTimeout(() => setMsg(''), 3000)
    } catch (e) {
      console.error(e)
      setMsg('Erro ao carregar: ' + (e.message || ''))
    }
  }, [])

  const imprimirRelatorio = useCallback(() => {
    setShowExportView(true)
  }, [])

  // Imprimir ficha do palete
  const handleImprimirFicha = useCallback(() => {
    // Criar janela de impressão temporária
    const printWindow = window.open('', '_blank', 'width=800,height=600')
    if (!printWindow) {
      alert('Permita popups para imprimir a ficha')
      return
    }

    const dataAtual = new Date().toLocaleDateString('pt-BR')
    const horaAtual = new Date().toLocaleTimeString('pt-BR')
    
    // Usar config (do banco) ou form (valores atuais) para garantir valores mais recentes
    const getVal = (key, defaultVal = '-') => {
      const val = config?.[key] ?? form?.[key]
      return val !== undefined && val !== null && val !== '' ? val : defaultVal
    }

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Ficha de Processo e Material - ${ferramenta || 'Palete'}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; padding: 20px; color: #333; }
    .header { text-align: center; margin-bottom: 20px; border-bottom: 3px solid #f59e0b; padding-bottom: 15px; }
    .header h1 { font-size: 22px; color: #1f2937; margin-bottom: 5px; }
    .header .ferramenta { font-size: 18px; color: #f59e0b; font-weight: bold; }
    .header .data { font-size: 11px; color: #6b7280; margin-top: 5px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px; }
    .box { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; background: #fafafa; }
    .box-title { font-size: 12px; font-weight: bold; color: #f59e0b; text-transform: uppercase; margin-bottom: 10px; border-bottom: 1px solid #e5e7eb; padding-bottom: 5px; }
    .row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12px; }
    .row label { color: #6b7280; }
    .row value { font-weight: bold; color: #1f2937; }
    .dimensoes { background: #ecfdf5; border: 1px solid #10b981; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
    .dimensoes h3 { color: #059669; font-size: 14px; margin-bottom: 10px; }
    .dim-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; text-align: center; }
    .dim-item { padding: 8px; background: white; border-radius: 4px; }
    .dim-item .num { font-size: 20px; font-weight: bold; color: #1f2937; }
    .dim-item .unit { font-size: 11px; color: #6b7280; }
    .cubagem { text-align: center; font-size: 16px; color: #7c3aed; font-weight: bold; margin-top: 10px; }
    .footer { margin-top: 30px; text-align: center; font-size: 10px; color: #9ca3af; border-top: 1px solid #e5e7eb; padding-top: 15px; }
    .ripas { margin-top: 15px; }
    .ripas h4 { font-size: 12px; color: #92400e; margin-bottom: 8px; }
    .ripas-list { font-size: 11px; }
    .ripas-list li { margin: 3px 0; }
    @media print { body { padding: 10px; } }
  </style>
</head>
<body>
  <div class="header">
    <h1>FICHA DE PROCESSO E MATERIAL</h1>
    <div class="ferramenta">${ferramenta || 'N/A'}${comprimento ? ' - ' + comprimento + 'mm' : ''}</div>
    <div class="data">Emitido em: ${dataAtual} às ${horaAtual}</div>
  </div>

  <div class="dimensoes">
    <h3>DIMENSÕES TOTAIS DO PALETE</h3>
    <div class="dim-grid">
      <div class="dim-item">
        <div class="num">${metricsPaleteAtual ? Math.round(metricsPaleteAtual.totalLarg * 1000) : '1200'}</div>
        <div class="unit">mm Largura</div>
      </div>
      <div class="dim-item">
        <div class="num">${metricsPaleteAtual ? Math.round(metricsPaleteAtual.totalAlt * 1000) : '672'}</div>
        <div class="unit">mm Altura Total</div>
      </div>
      <div class="dim-item">
        <div class="num">${metricsPaleteAtual ? Math.round(metricsPaleteAtual.totalProf * 1000) : '1000'}</div>
        <div class="unit">mm Comprimento</div>
      </div>
    </div>
    <div class="cubagem">
      Cubagem: ${metricsPaleteAtual ? metricsPaleteAtual.volume.toFixed(3) : '0.000'} m³
    </div>
  </div>

  <div class="grid">
    <div class="box">
      <div class="box-title">Estrutura do Palete</div>
      <div class="row"><label>Tipo:</label><value>${getVal('tipo_palete')?.replace('PBR_', 'PBR ')?.replace(/x/g, '×') || 'PBR 1200×1000'}</value></div>
      <div class="row"><label>Pacotes/Camada:</label><value>${getVal('pacotes_por_camada', '-')}</value></div>
      <div class="row"><label>Camadas/Bloco:</label><value>${getVal('camadas_por_bloco', '-')}</value></div>
      <div class="row"><label>Número de Blocos:</label><value>${getVal('num_blocos', '-')}</value></div>
      <div class="row"><label>Total de Pacotes:</label><value>${(getVal('pacotes_por_camada', 0)) * (getVal('camadas_por_bloco', 0)) * (getVal('num_blocos', 0))} un</value></div>
    </div>

    <div class="box">
      <div class="box-title">Dimensões do Material</div>
      <div class="row"><label>Largura:</label><value>${getVal('largura_pacote_mm', '-')} mm</value></div>
      <div class="row"><label>Altura:</label><value>${getVal('altura_pacote_mm', '-')} mm</value></div>
      <div class="row"><label>Comprimento:</label><value>${getVal('profundidade_pacote_mm', '-')} mm</value></div>
      <div class="row"><label>Orientação:</label><value>${getVal('orientacao_pacote') === 'longitudinal' ? '↕ Longitudinal' : '↔ Transversal'}</value></div>
    </div>
  </div>

  <div class="box">
    <div class="box-title">Ripas Necessárias</div>
    <div class="ripas-list">
      <div class="row"><label>Ripas Laterais:</label><value>${getVal('num_ripas_lateral', 2)} ripas de ${getVal('ripa_vert_comp_mm', getVal('profundidade_pacote_mm', 1000))}mm</value></div>
      <div class="row"><label>Ripas Entre Camadas:</label><value>${((getVal('num_blocos', 1)) - 1) * (getVal('num_ripas_por_camada', 1))} ripas de ${getVal('ripa_comprimento_mm', 1000)}mm</value></div>
      <div class="row"><label>Total de Ripas:</label><value>${(getVal('num_ripas_lateral', 2)) + (((getVal('num_blocos', 1)) - 1) * (getVal('num_ripas_por_camada', 1)))} ripas</value></div>
    </div>
  </div>

  <div class="footer">
    Documento gerado automaticamente pelo sistema de usinagem
  </div>

  <script>window.onload = () => { setTimeout(() => { window.print(); }, 500); };</script>
</body>
</html>`

    printWindow.document.write(html)
    printWindow.document.close()
  }, [ferramenta, comprimento, config, form, metricsPaleteAtual])

  // Auto-carregar simulação via prop (quando acessado via URL)
  useEffect(() => {
    if (!simulacaoId) return
    carregarSimulacao(simulacaoId).then(() => {
      onSimulacaoLoaded?.({ id: simulacaoId })
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // ─── FIM SAVE / LOAD / EXPORT ──────────────────────────────────────────────────

  const handleSelecionarItem = (id) => setItemSelecionadoId(id)

  const handleQuantidadeItemChange = (id, valor) => {
    const parsed = Math.max(0, Math.round(Number(valor) || 0))
    setFilaItens(prev => prev.map(item => (
      item.id === id ? { ...item, quantidade: parsed } : item
    )))
  }

  const handleRemoverItem = (id) => {
    setFilaItens(prev => prev.filter(item => item.id !== id))
  }

  const handleAdicionarPaleteConfigurado = () => {
    if (!itemBaseConfigurado) return
    const novo = { ...itemBaseConfigurado, id: gerarId(), origem: 'snapshot_config', quantidade: 1 }
    setFilaItens(prev => [...prev, novo])
    setItemSelecionadoId(novo.id)
  }

  const parseMetroInput = (valor) => {
    if (typeof valor === 'string') {
      const sanitized = valor.replace(',', '.')
      const parsed = parseFloat(sanitized)
      return Number.isFinite(parsed) ? parsed : null
    }
    return Number.isFinite(valor) ? valor : null
  }

  const handleNovoItemChange = (e) => {
    const { name, value } = e.target
    setNovoItem(prev => ({ ...prev, [name]: value }))
    setNovoItemErro('')
  }

  const handleAdicionarItemManual = () => {
    const largura = parseMetroInput(novoItem.largura)
    const comprimento = parseMetroInput(novoItem.comprimento)
    const altura = parseMetroInput(novoItem.altura)
    const quantidade = Math.max(1, Math.round(Number(novoItem.quantidade) || 0))

    if (!largura || !comprimento || !altura) {
      setNovoItemErro('Informe dimensões válidas em metros (ex: 1.20).')
      return
    }

    const novo = {
      id: gerarId(),
      titulo: novoItem.titulo || 'Item manual',
      subtitulo: 'Cadastro manual',
      largura,
      comprimento,
      altura,
      volume: largura * comprimento * altura,
      quantidade,
    }
    setFilaItens(prev => [...prev, novo])
    setItemSelecionadoId(novo.id)
    setNovoItem(prev => ({ ...prev, quantidade: '1' }))
    setNovoItemErro('')
  }

  const handleRomaneioDimensaoChange = (key, campo, valor) => {
    setRomaneioDimensoes(prev => ({
      ...prev,
      [key]: {
        ...(prev[key] || {}),
        [campo]: valor,
      },
    }))
    setRomaneioDimensoesErro(prev => {
      if (!prev[key]) return prev
      const atualizado = { ...prev }
      delete atualizado[key]
      return atualizado
    })
  }

  const handleAdicionarRomaneioPalete = (entrada) => {
    const dims = romaneioDimensoes[entrada.key] || {}
    const largura = parseMetroInput(dims.largura)
    const comprimento = parseMetroInput(dims.comprimento)
    const altura = parseMetroInput(dims.altura)
    const quantidade = Math.max(1, Math.round(Number(dims.quantidade) || 1))
    const jaAdicionado = filaItens.some((item) => item.metadataRomaneio?.key === entrada.key)

    if (!largura || !comprimento || !altura) {
      setRomaneioDimensoesErro(prev => ({
        ...prev,
        [entrada.key]: 'Informe L, C e H em metros para adicionar este palete.',
      }))
      return
    }

    if (jaAdicionado) return

    const novo = {
      id: gerarId(),
      origem: 'romaneio',
      titulo: entrada.rack,
      subtitulo: `Romaneio ${entrada.romaneioNumero}${entrada.clientes.length ? ` · ${entrada.clientes[0]}` : ''}`,
      largura,
      comprimento,
      altura,
      volume: largura * comprimento * altura,
      quantidade, // número de paletes (para UI)
      quantidadePecas: entrada.quantidadePecas || 0, // número real de peças
      metadataRomaneio: {
        key: entrada.key,
        romaneioId: entrada.romaneioId,
        romaneioNumero: entrada.romaneioNumero,
      },
    }

    setFilaItens(prev => [...prev, novo])
    setItemSelecionadoId(novo.id)
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-white">

        {/* Header com Tabs e Toggle */}
        <div className="px-4 py-2 bg-white border-b border-gray-200 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {[
              { id: 'visualizacao', label: 'Visualização 3D' },
              { id: 'amarrado', label: 'Amarrados' },
              { id: 'validacao', label: 'Validação 2D' },
              { id: 'cubagem', label: 'Cubagem em Caminhões' },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => { setActiveTab(tab.id); onActiveTabChange?.(tab.id) }}
                className={`${classes.pxSm} ${classes.pySm} rounded-full border ${classes.textXs} uppercase tracking-wide font-semibold transition ${activeTab === tab.id
                  ? 'bg-amber-100 border-amber-400 text-amber-800 shadow-sm'
                  : 'border-gray-200 text-gray-500 hover:text-amber-600'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          
          {/* Toggle Sidebar em modo compacto */}
          {screen.isCompact && (
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              title={sidebarOpen ? 'Fechar painel' : 'Abrir painel'}
            >
              {sidebarOpen ? <FaChevronRight size={16} /> : <FaChevronLeft size={16} />}
            </button>
          )}
        </div>

        {activeTab === 'amarrado' ? (
          <div className="flex flex-1 min-h-0 overflow-hidden relative">
            <div className="flex-1 bg-gray-900 flex flex-col overflow-hidden min-h-0">
              <div className="px-3 py-2 bg-gray-800 border-b border-gray-700 flex items-center gap-2 text-white">
                <FaCubes className="text-amber-400" />
                <span className="text-xs font-semibold uppercase tracking-wide">Configurador de Amarrados</span>
              </div>
              <AmarradoVisualizacao3D
                tipo={amarrado.tipo}
                quantidade={amarrado.quantidade}
                pecasPorLinha={amarrado.pecas_por_linha}
                largura={amarrado.largura}
                altura={amarrado.altura}
                espacamento={amarrado.espacamento}
                comprimento={amarrado.comprimento}
                cor={amarrado.cor}
                mostrarFilme={amarrado.mostrar_filme}
              />
            </div>

            {/* Sidebar Amarrado */}
            <div className={`${
              screen.isCompact
                ? `fixed inset-y-0 right-0 z-40 w-full sm:w-80 bg-slate-50 border-l border-slate-200 shadow-2xl transition-transform duration-300 flex flex-col overflow-hidden ${
                    sidebarOpen ? 'translate-x-0' : 'translate-x-full'
                  }`
                : `w-80 flex-shrink-0 bg-slate-50 border-l border-slate-200 overflow-hidden flex flex-col`
            }`}>
              <div className="flex items-center justify-between px-4 py-3 bg-white border-b border-slate-200">
                <h4 className="text-sm font-black text-slate-800 uppercase tracking-wider">Perfil & Amarrado</h4>
              </div>

              {/* Botões de Salvar/Carregar Modelo */}
              <div className="px-4 py-2 bg-slate-100 border-b border-slate-200 flex gap-2">
                <button
                  onClick={() => setShowSalvarModeloModal(true)}
                  className="flex-1 flex items-center justify-center gap-2 py-2 px-3 bg-green-600 hover:bg-green-700 text-white text-xs font-bold rounded-lg transition-colors"
                  title="Salvar configuração atual como modelo"
                >
                  <FaSave size={14} />
                  Salvar Modelo
                </button>
                <button
                  onClick={() => setShowCarregarModeloModal(true)}
                  className="flex-1 flex items-center justify-center gap-2 py-2 px-3 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg transition-colors"
                  title="Carregar um modelo salvo"
                >
                  <FaFolderOpen size={14} />
                  Carregar
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-6">
                <SectionBlock title="Tipo de Perfil" color="blue" number="1">
                  <div className="flex gap-2">
                    {['circular', 'retangular'].map(t => (
                      <button
                        key={t}
                        onClick={() => setAmarrado(prev => ({ ...prev, tipo: t }))}
                        className={`flex-1 py-2 px-3 rounded-lg border text-[10px] font-bold uppercase transition-all ${
                          amarrado.tipo === t ? 'bg-indigo-600 border-indigo-700 text-white shadow-md' : 'bg-white border-slate-200 text-slate-400 hover:border-indigo-300'
                        }`}
                      >
                        {t === 'circular' ? 'Circular' : 'Retangular'}
                      </button>
                    ))}
                  </div>
                </SectionBlock>

                <SectionBlock title="Dimensões do Perfil" color="amber" number="2">
                  <div className="space-y-4">
                    <div>
                      <FieldLabel>{amarrado.tipo === 'circular' ? 'Diâmetro (mm)' : 'Largura (mm)'}</FieldLabel>
                      <input
                        type="number"
                        name="largura"
                        value={amarrado.largura}
                        onChange={handleAmarradoChange}
                        className={inputCls}
                      />
                    </div>
                    {amarrado.tipo === 'retangular' && (
                      <div>
                        <FieldLabel>Altura (mm)</FieldLabel>
                        <input
                          type="number"
                          name="altura"
                          value={amarrado.altura}
                          onChange={handleAmarradoChange}
                          className={inputCls}
                        />
                      </div>
                    )}
                    <div>
                      <FieldLabel>Comprimento (mm)</FieldLabel>
                      <input
                        type="number"
                        name="comprimento"
                        value={amarrado.comprimento}
                        onChange={handleAmarradoChange}
                        className={inputCls}
                      />
                    </div>
                  </div>
                </SectionBlock>

                <SectionBlock title="Configuração Amarrado" color="green" number="3">
                  <div className="space-y-4">
                    <div>
                      <FieldLabel>Quantidade Total de Peças</FieldLabel>
                      <input
                        type="number"
                        name="quantidade"
                        value={amarrado.quantidade}
                        onChange={handleAmarradoChange}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <FieldLabel>Peças por Linha (Base)</FieldLabel>
                      <input
                        type="number"
                        name="pecas_por_linha"
                        value={amarrado.pecas_por_linha}
                        onChange={handleAmarradoChange}
                        className={inputCls}
                        placeholder="Ex: 5"
                      />
                    </div>
                    <div>
                      <FieldLabel>Espaçamento (mm)</FieldLabel>
                      <input
                        type="number"
                        name="espacamento"
                        value={amarrado.espacamento}
                        onChange={handleAmarradoChange}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <FieldLabel>Cor do Amarrado</FieldLabel>
                      <div className="flex items-center gap-3">
                        <input
                          type="color"
                          name="cor"
                          value={amarrado.cor}
                          onChange={handleAmarradoChange}
                          className="w-10 h-10 rounded-lg cursor-pointer border border-slate-200"
                        />
                        <span className="text-xs font-mono text-slate-500 uppercase">{amarrado.cor}</span>
                      </div>
                    </div>
                    <Divider />
                    <div className="flex items-center justify-between">
                      <FieldLabel>Simular Filme Plástico</FieldLabel>
                      <Toggle
                        name="mostrar_filme"
                        checked={amarrado.mostrar_filme}
                        editando={true}
                        onChange={handleAmarradoChange}
                      />
                    </div>
                  </div>
                </SectionBlock>

                <SectionBlock title="Preview 2D" color="gray" number="4">
                  <div className="bg-slate-800 rounded-lg p-2 aspect-square flex items-center justify-center overflow-hidden">
                    <canvas 
                      id="amarrado2d" 
                      width="200" 
                      height="200" 
                      className="w-full h-full"
                    />
                  </div>
                </SectionBlock>
              </div>
            </div>
          </div>
        ) : activeTab === 'validacao' ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            <PaleteDetalhe2D
              ferramenta={ferramenta}
              comprimento={comprimento}
              config={config}
              ferramentaCfg={(() => {
                const ferrNorm = ferramenta ? `${ferramenta.replace(/-/g, '').slice(0, 2)}-${ferramenta.replace(/-/g, '').slice(2)}` : ''
                const compNum = comprimento ? parseInt(comprimento, 10) : 0
                return ferramentasCfgData.find(c => {
                  const cf = String(c?.ferramenta || '').toUpperCase()
                  if (cf !== ferramenta?.toUpperCase() && cf !== ferrNorm?.toUpperCase()) return false
                  if (!compNum) return true
                  const cc = Number(c?.comprimento_mm || 0)
                  return cc ? cc === compNum : true
                }) || ferramentasCfgData.find(c => String(c?.ferramenta || '').toUpperCase() === ferramenta?.toUpperCase()) || null
              })()}
            />
          </div>
        ) : activeTab === 'visualizacao' ? (
          <div className="flex flex-1 min-h-0 overflow-hidden relative">
            {/* ── Painel 3D ── */}
            <div className="flex-1 bg-gray-900 flex flex-col overflow-hidden min-h-0" style={{ minHeight: '300px' }}>
              <div className="px-3 py-2 bg-gray-800 border-b border-gray-700 flex items-center gap-2">
                <span className="text-xs font-semibold text-gray-300 uppercase tracking-wide">Visualização 3D Interativa</span>
                {form.descricao_montagem && (
                  <span className="text-xs text-gray-500">· {form.descricao_montagem}</span>
                )}
              </div>

              {loading ? (
                <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">Carregando...</div>
              ) : (
                <div className="flex-1 overflow-hidden" style={{ minHeight: '250px' }}>
                  <PaleteVisualizacao3D
                    pacotesPorCamada={Number(form.pacotes_por_camada) || 3}
                    camadasPorBloco={Number(form.camadas_por_bloco) || 3}
                    tipoPalete={form.tipo_palete || 'PBR_1200x1000'}
                    numBlocos={Number(form.num_blocos) || 3}
                    larguraPacoteMm={Number(form.largura_pacote_mm) || 300}
                    alturaPacoteMm={Number(form.altura_pacote_mm) || 100}
                    profundidadePacoteMm={Number(form.profundidade_pacote_mm) || 6000}
                    corPacote={form.cor_pacote || '#b0b8c1'}
                    // Ripas entre camadas
                    ripaEntreBlocos={form.ripa_entre_camadas}
                    numRipasPorCamada={Number(form.num_ripas_por_camada) || 3}
                    ripasEntrePosicao={form.ripas_entre_posicao || 'uniforme'}
                    ripasEntreOffsetMm={Number(form.ripas_entre_offset_mm) || 0}
                    ripasEntreManual={form.ripas_entre_manual}
                    ripasEntrePosicoes={form.ripas_entre_posicoes || ''}
                    ripaAlturaMm={Number(form.ripa_altura_mm) || 30}
                    ripaLarguraMm={Number(form.ripa_largura_mm) || 50}
                    ripaComprimentoMm={Number(form.ripa_comprimento_mm) || 1200}
                    ripaTopo={form.ripa_topo}
                    // Camada final
                    camadaFinalAtiva={form.camada_final_ativa}
                    camadaFinalQtd={Number(form.camada_final_qtd) || 1}
                    camadaFinalPosicao={form.camada_final_posicao || 'centralizada'}
                    // Multi-pilha
                    multiPilhaAtiva={form.multi_pilha_ativa}
                    multiPilhaQtd={Number(form.multi_pilha_qtd) || 1}
                    multiPilhaFolgaMm={Number(form.multi_pilha_folga_mm) || 50}
                    // Ripas laterais
                    ripaVertical={form.ripa_vertical}
                    numRipasLateral={Number(form.num_ripas_lateral) || 3}
                    ripasLatPosicao={form.ripas_lat_posicao || 'uniforme'}
                    ripasLatOffsetMm={Number(form.ripas_lat_offset_mm) || 0}
                    ripasLatManual={form.ripas_lat_manual}
                    ripasLatPosicoes={form.ripas_lat_posicoes || ''}
                    ripasLatMargemMm={Number(form.ripas_lat_margem_mm) || 40}
                    ripaVertLarguraMm={Number(form.ripa_vert_largura_mm) || 50}
                    ripaVertCompMm={Number(form.ripa_vert_comp_mm) || 30}
                    ripaVertAlturaMm={Number(form.ripa_vert_altura_mm) || 1080}
                    onChangeRipaMargemInteractive={handleInteractiveMargem}
                    // Orientação
                    orientacaoPacote={form.orientacao_pacote || 'longitudinal'}
                    // Visualização
                    mostrarCotas={form.mostrar_cotas !== false}
                    // Peso
                    pesoPacoteKg={Number(form.peso_pacote_kg) || 0}
                    // Amarrado (substitui pacote retangular por peças individuais)
                    amarradoConfig={modeloAmarradoSelecionado ? {
                      tipo: modeloAmarradoSelecionado.tipo,
                      quantidade: Number(modeloAmarradoSelecionado.quantidade),
                      pecasPorLinha: Number(modeloAmarradoSelecionado.pecas_por_linha),
                      largura: Number(modeloAmarradoSelecionado.largura),
                      altura: Number(modeloAmarradoSelecionado.altura) || Number(modeloAmarradoSelecionado.largura),
                      espacamento: Number(modeloAmarradoSelecionado.espacamento) || 0,
                      comprimentoPerfil: Number(modeloAmarradoSelecionado.comprimento_perfil) || Number(form.profundidade_pacote_mm) || null,
                    } : null}
                  />
                </div>
              )}

              {/* Legenda */}
              <div className="px-4 py-2 bg-gray-800 flex items-center gap-4 text-[10px] text-gray-400 flex-wrap border-t border-gray-700">
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded inline-block" style={{ background: form.cor_pacote }} />
                  Pacote ({form.pacotes_por_camada}×camada × {totalCamadasPlanejadas} camadas)
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded inline-block bg-yellow-700" />
                  Ripa {form.ripa_entre_camadas ? `(${form.num_ripas_por_camada}/camada` : '(desativada'}
                  {form.ripa_vertical ? ' + lateral' : ''}{form.ripa_topo ? ' + topo' : ''})
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded inline-block bg-yellow-900" />
                  Base
                </span>
              </div>
            </div>

            {/* ── Painel de configuração ── */}
            {/* Overlay para fechar em mobile */}
            {screen.isCompact && sidebarOpen && (
              <div
                className="fixed inset-0 bg-black/30 z-30"
                onClick={() => setSidebarOpen(false)}
              />
            )}

            <div className={`${
              screen.isCompact
                ? `fixed inset-y-0 right-0 z-40 w-full sm:w-96 bg-slate-50 border-l border-slate-200 shadow-2xl transition-transform duration-300 flex flex-col overflow-hidden ${
                    sidebarOpen ? 'translate-x-0' : 'translate-x-full'
                  }`
                : `w-full md:w-80 lg:w-96 flex-shrink-0 bg-slate-50 border-l border-slate-200 overflow-hidden flex flex-col`
            }`}>
              {/* Header do painel */}
              <div className="flex items-center justify-between px-4 py-3 bg-white border-b border-slate-200 flex-shrink-0 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse"></div>
                  <h4 className={`${classes.textSm} font-black text-slate-800 uppercase tracking-[0.1em]`}>Configuração</h4>
                </div>
                <div className="flex items-center gap-2">
                  {/* Botão Imprimir */}
                  {(config || form.ripa_entre_camadas) && !editando && (
                    <button onClick={handleImprimirFicha}
                      className="flex items-center gap-1.5 text-xs bg-slate-700 hover:bg-slate-800 text-white px-3 py-2 rounded-xl font-bold transition-all shadow-sm hover:shadow active:scale-95"
                      title="Imprimir ficha do palete">
                      <FaPrint className="w-3 h-3" /> Imprimir
                    </button>
                  )}
                  {isAdmin && !editando && (
                    <button onClick={() => setEditando(true)}
                      className="flex items-center gap-1.5 text-xs bg-amber-500 hover:bg-amber-600 text-white px-4 py-2 rounded-xl font-bold transition-all shadow-sm hover:shadow active:scale-95">
                      <FaEdit className="w-3 h-3" /> Editar
                    </button>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto py-3 px-1 scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-slate-100">
                {/* ── SELETOR DE AMARRADO ── */}
                <div className="mx-4 mb-4 p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                  <label className="block text-xs font-bold text-emerald-700 uppercase mb-2">Usar Modelo de Amarrado</label>
                  
                  {carregandoModelos ? (
                    <div className="text-xs text-emerald-600 font-semibold">⏳ Carregando modelos...</div>
                  ) : modelosAmarrado.length === 0 ? (
                    <div className="text-xs text-emerald-600 font-semibold">
                      Nenhum modelo salvo para TR-{ferramenta} / {comprimento}mm
                    </div>
                  ) : (
                    <>
                      <select
                        value={modeloAmarradoSelecionado?.id || ''}
                        onChange={(e) => {
                          if (!e.target.value) {
                            setModeloAmarradoSelecionado(null)
                            return
                          }
                          const modelo = modelosAmarrado.find(m => m.id === e.target.value)
                          if (modelo) {
                            setModeloAmarradoSelecionado(modelo)
                            
                            // Calcular dimensões TOTAIS do amarrado
                            const qtd = Number(modelo.quantidade) || 1
                            const porLinha = Number(modelo.pecas_por_linha) || 1
                            const larguraPerfil = Number(modelo.largura) || 0
                            const alturaPerfil = Number(modelo.altura) || larguraPerfil
                            const espac = Number(modelo.espacamento) || 0
                            const numLinhas = Math.ceil(qtd / porLinha)
                            
                            const larguraTotal = porLinha * larguraPerfil + (porLinha - 1) * espac
                            const alturaTotal = numLinhas * alturaPerfil + (numLinhas - 1) * espac
                            const comprimentoTotal = Number(modelo.comprimento_perfil) || 0
                            
                            console.log('🔧 Amarrado selecionado:', {
                              modelo: modelo.nome,
                              dimensoesAmarrado: { larguraTotal, alturaTotal, comprimentoTotal }
                            })
                            
                            // NÃO substituir dimensões automaticamente - mantém as configurações do palete
                            // Apenas aplica a cor do amarrado
                            setForm(prev => ({
                              ...prev,
                              cor_pacote: modelo.cor || prev.cor_pacote,
                            }))
                          }
                        }}
                        className="w-full px-2 py-1.5 border border-emerald-300 rounded text-xs font-semibold text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      >
                        <option value="">-- Nenhum (padrão) --</option>
                        {modelosAmarrado.map(modelo => (
                          <option key={modelo.id} value={modelo.id}>
                            {modelo.nome} ({modelo.tipo === 'circular' ? '⭕' : '▭'} {modelo.quantidade}pc)
                          </option>
                        ))}
                      </select>
                      {modeloAmarradoSelecionado && (() => {
                        const qtd = Number(modeloAmarradoSelecionado.quantidade) || 1
                        const porLinha = Number(modeloAmarradoSelecionado.pecas_por_linha) || 1
                        const larguraPerfil = Number(modeloAmarradoSelecionado.largura) || 0
                        const alturaPerfil = Number(modeloAmarradoSelecionado.altura) || larguraPerfil
                        const espac = Number(modeloAmarradoSelecionado.espacamento) || 0
                        const numLinhas = Math.ceil(qtd / porLinha)
                        const larguraTotal = Math.round(porLinha * larguraPerfil + (porLinha - 1) * espac)
                        const alturaTotal = Math.round(numLinhas * alturaPerfil + (numLinhas - 1) * espac)
                        return (
                          <div className="mt-2 p-2 bg-white rounded border border-emerald-200 text-[10px] space-y-1">
                            <p className="font-bold text-emerald-700">✓ {modeloAmarradoSelecionado.nome}</p>
                            <p className="text-slate-600">
                              {qtd}pc · {porLinha}/linha · perfil {larguraPerfil}mm
                            </p>
                            <div className="pt-1 border-t border-emerald-100">
                              <p className="text-emerald-700 font-semibold">Tamanho ideal do pacote:</p>
                              <p className="text-slate-700 font-mono">
                                {larguraTotal} × {alturaTotal} × {modeloAmarradoSelecionado.comprimento_perfil}mm
                              </p>
                            </div>
                            <button
                              onClick={() => {
                                setForm(prev => ({
                                  ...prev,
                                  largura_pacote_mm: larguraTotal,
                                  altura_pacote_mm: alturaTotal,
                                  // NÃO alterar profundidade_pacote_mm - é a dimensão do palete, não do material
                                }))
                              }}
                              className="w-full mt-1 px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold rounded transition-colors"
                            >
                              Aplicar dimensões do amarrado
                            </button>
                          </div>
                        )
                      })()}
                    </>
                  )}
                </div>

                {!config && !editando && !loading && (
                  <div className="mx-4 mb-5 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-2xl p-4 flex flex-col gap-2 shadow-sm">
                    <span className="font-bold flex items-center gap-2">
                      <span className="text-lg">⚠️</span> Sem configuração cadastrada
                    </span>
                    {isAdmin && (
                      <button onClick={() => setEditando(true)} className="text-amber-600 hover:text-amber-700 underline font-bold text-sm text-left transition-colors">
                        + Cadastrar agora para esta ferramenta
                      </button>
                    )}
                  </div>
                )}

                {/* ── BLOCO 1: PALETE ── */}
                <SectionBlock title="Estrutura do Palete" color="amber" number="1">
                  <Row label="Tipo de Palete">
                    {editando
                      ? <select name="tipo_palete" value={form.tipo_palete} onChange={handleChange} className={inputCls}>
                          <option value="PBR_1000x1000">PBR 1000×1000</option>
                          <option value="PBR_1200x1200">PBR 1200×1200</option>
                          <option value="PBR_1200x800">PBR 1200×800</option>
                          <option value="PBR_1200x1000">PBR 1200×1000</option>
                        </select>
                      : <Val>{
                          (() => {
                            const map = {
                              PBR_1000x1000: 'PBR 1000×1000 mm',
                              PBR_1200x1200: 'PBR 1200×1200 mm',
                              PBR_1200x800: 'PBR 1200×800 mm',
                              PBR_1200x1000: 'PBR 1200×1000 mm',
                            }
                            return map[config?.tipo_palete] ?? 'PBR 1200×1000 mm'
                          })()
                        }</Val>}
                  </Row>

                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <FieldLabel>Pct/Cam.</FieldLabel>
                      {editando ? <input type="number" name="pacotes_por_camada" min="1" max="30" value={form.pacotes_por_camada ?? ''} onChange={handleChange} className={inputCls} /> : <Val>{config?.pacotes_por_camada}</Val>}
                    </div>
                    <div>
                      <FieldLabel>Cam/Bloco</FieldLabel>
                      {editando ? <input type="number" name="camadas_por_bloco" min="1" max="20" value={form.camadas_por_bloco ?? ''} onChange={handleChange} className={inputCls} /> : <Val>{config?.camadas_por_bloco}</Val>}
                    </div>
                    <div>
                      <FieldLabel>Blocos</FieldLabel>
                      {editando ? <input type="number" name="num_blocos" min="1" max="10" value={form.num_blocos ?? ''} onChange={handleChange} className={inputCls} /> : <Val>{config?.num_blocos}</Val>}
                    </div>
                  </div>

                  <Divider />
                  <FieldLabel>Dimensões do material (mm)</FieldLabel>
                  <Trio labels={['Largura', 'Altura', 'Comprimento']} names={['largura_pacote_mm', 'altura_pacote_mm', 'profundidade_pacote_mm']} min={10} max={20000} editando={editando} form={form} handleChange={handleChange} config={config} />

                  <Divider />
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <FieldLabel>Sentido Material</FieldLabel>
                      {editando
                        ? <select name="orientacao_pacote" value={form.orientacao_pacote} onChange={handleChange} className={inputCls}>
                            <option value="longitudinal">↕ Longitudinal</option>
                            <option value="transversal">↔ Transversal</option>
                          </select>
                        : <Val>{(config?.orientacao_pacote ?? 'longitudinal') === 'transversal' ? '↔ Transversal' : '↕ Longitudinal'}</Val>}
                    </div>
                    <div>
                      <FieldLabel>Cor do 3D</FieldLabel>
                      {editando
                        ? <div className="flex items-center gap-2">
                            <input type="color" name="cor_pacote" value={form.cor_pacote} onChange={handleChange} className="w-10 h-10 rounded-lg cursor-pointer border border-slate-300 p-1 bg-white" />
                            <span className="text-xs text-slate-500 font-mono uppercase font-bold">{form.cor_pacote}</span>
                          </div>
                        : <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-lg border border-slate-300 shadow-sm" style={{ background: config?.cor_pacote || '#b0b8c1' }} />
                            <span className="text-xs text-slate-500 font-mono uppercase font-bold">{config?.cor_pacote || '#b0b8c1'}</span>
                          </div>}
                    </div>
                  </div>

                  {/* ── MULTI-PILHA (quando material menor que palete) ── */}
                  <Divider />
                  <div className="pt-1">
                    <Row label="Múltiplas pilhas no mesmo palete">
                      <Toggle name="multi_pilha_ativa" checked={editando ? form.multi_pilha_ativa : config?.multi_pilha_ativa} editando={editando} onChange={handleChange} />
                    </Row>
                    {(editando ? form.multi_pilha_ativa : config?.multi_pilha_ativa) && (
                      <div className="mt-3 p-3 bg-sky-50/60 rounded-lg border border-sky-200/60 animate-in fade-in slide-in-from-top-2 duration-300">
                        {editando && (
                          <div className="mb-3 p-2 bg-white/70 rounded border border-sky-200 text-[11px] leading-relaxed">
                            <div className="font-bold text-sky-800 mb-1">💡 Sugestão automática</div>
                            <div className="text-slate-700">
                              Palete: <b>{multiPilhaSugestao.eixoPalete}mm</b> ({multiPilhaSugestao.nomeEixo})
                            </div>
                            <div className="text-slate-700">
                              Material: <b>{multiPilhaSugestao.compMaterial}mm</b> + folga <b>{multiPilhaSugestao.folga}mm</b>
                            </div>
                            <div className={`mt-1 font-bold ${multiPilhaSugestao.cabe ? 'text-emerald-700' : 'text-amber-700'}`}>
                              {multiPilhaSugestao.cabe
                                ? `✅ Cabem ${multiPilhaSugestao.qtd} pilhas no palete`
                                : '⚠️ Material não permite múltiplas pilhas'}
                            </div>
                          </div>
                        )}
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <FieldLabel>Qtd de pilhas</FieldLabel>
                            {editando
                              ? <div className="flex gap-1">
                                  <input type="number" name="multi_pilha_qtd" min="1" max="4" value={form.multi_pilha_qtd ?? ''} onChange={handleChange} className={inputCls} />
                                  {multiPilhaSugestao.cabe && Number(form.multi_pilha_qtd) !== multiPilhaSugestao.qtd && (
                                    <button
                                      type="button"
                                      onClick={() => setForm(prev => ({ ...prev, multi_pilha_qtd: multiPilhaSugestao.qtd }))}
                                      className="px-2 py-1 text-[10px] bg-sky-600 text-white rounded hover:bg-sky-700 font-bold whitespace-nowrap"
                                      title="Usar sugestão"
                                    >
                                      usar {multiPilhaSugestao.qtd}
                                    </button>
                                  )}
                                </div>
                              : <Val>{config?.multi_pilha_qtd || 1}</Val>}
                          </div>
                          <div>
                            <FieldLabel>Folga entre pilhas (mm)</FieldLabel>
                            {editando
                              ? <input type="number" name="multi_pilha_folga_mm" min="0" max="500" value={form.multi_pilha_folga_mm ?? ''} onChange={handleChange} className={inputCls} />
                              : <Val>{config?.multi_pilha_folga_mm || 50} mm</Val>}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <Divider />
                  <div className="flex flex-col gap-3">
                    <Row label="Mostrar cotas no visualizador 3D">
                      <Toggle name="mostrar_cotas" checked={editando ? form.mostrar_cotas : config?.mostrar_cotas} editando={editando} onChange={handleChange} />
                    </Row>

                    <Row label="Peso unitário por pacote (kg)">
                      {editando
                        ? <div className="relative">
                            <input
                              type="number"
                              name="peso_pacote_kg"
                              min="0"
                              step="0.1"
                              placeholder="0.0"
                              value={form.peso_pacote_kg}
                              onChange={handleChange}
                              className={`${inputCls} pr-8`}
                            />
                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-slate-400 font-bold">kg</span>
                          </div>
                        : <Val>{config?.peso_pacote_kg ? `${config.peso_pacote_kg} kg` : <span className="text-slate-400 text-xs font-medium italic">Não informado</span>}</Val>}
                    </Row>
                  </div>
                </SectionBlock>

                {/* ── BLOCO 2: RIPAS ENTRE CAMADAS ── */}
                <SectionBlock title="Ripas Entre Camadas" color="orange" number="2">
                  <Row label="Ativar ripas transversais">
                    <Toggle name="ripa_entre_camadas" checked={editando ? form.ripa_entre_camadas : config?.ripa_entre_camadas} editando={editando} onChange={handleChange} />
                  </Row>

                  {(editando ? form.ripa_entre_camadas : config?.ripa_entre_camadas) && (
                    <div className="space-y-4 pt-1 animate-in fade-in slide-in-from-top-2 duration-300">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <FieldLabel>Qtd de ripas</FieldLabel>
                          {editando ? <input type="number" name="num_ripas_por_camada" min="1" max="8" value={form.num_ripas_por_camada ?? ''} onChange={handleChange} className={inputCls} /> : <Val>{config?.num_ripas_por_camada}</Val>}
                        </div>
                        <div>
                          <FieldLabel>Alinhamento</FieldLabel>
                          {editando
                            ? <select name="ripas_entre_posicao" value={form.ripas_entre_posicao} onChange={handleChange} className={inputCls}>
                                <option value="uniforme">Uniforme</option>
                                <option value="centro">Centro</option>
                                <option value="extremos">Extremos</option>
                              </select>
                            : <Val>{config?.ripas_entre_posicao || 'uniforme'}</Val>}
                        </div>
                      </div>

                      <Divider />
                      <FieldLabel>Espessura da ripa (mm)</FieldLabel>
                      <Trio labels={['Altura (Y)', 'Espessura (Z)', 'Comprimento']} names={['ripa_altura_mm', 'ripa_largura_mm', 'ripa_comprimento_mm']} min={10} max={20000} editando={editando} form={form} handleChange={handleChange} config={config} />

                      <Divider />
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <FieldLabel>Ajuste das Pontas (mm)</FieldLabel>
                          {editando
                            ? <div className="relative">
                                <input type="number" name="ripas_entre_offset_mm" value={form.ripas_entre_offset_mm ?? ''} onChange={handleChange} min="0" max="500" step="10" className={`${inputCls} py-3`} />
                                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">mm</span>
                              </div>
                            : <Val sufixo="mm">{config?.ripas_entre_offset_mm}</Val>}
                          <span className="text-[10px] text-slate-500 mt-1 block">Desconta das pontas para dentro</span>
                        </div>
                        <Row label="Controle Manual">
                          <Toggle name="ripas_entre_manual" checked={editando ? form.ripas_entre_manual : config?.ripas_entre_manual} editando={editando} onChange={handleChange} />
                        </Row>
                      </div>
                    </div>
                  )}

                  <Divider />
                  <Row label="Adicionar ripas no topo da carga">
                    <Toggle name="ripa_topo" checked={editando ? form.ripa_topo : config?.ripa_topo} editando={editando} onChange={handleChange} />
                  </Row>

                  {/* ── CAMADA FINAL (AJUSTE DE ALTURA) ── */}
                  <Divider />
                  <div className="pt-2">
                    <Row label="Ativar camada final diferente">
                      <Toggle name="camada_final_ativa" checked={editando ? form.camada_final_ativa : config?.camada_final_ativa} editando={editando} onChange={handleChange} />
                    </Row>
                    {(editando ? form.camada_final_ativa : config?.camada_final_ativa) && (
                      <div className="mt-3 p-3 bg-amber-50/50 rounded-lg border border-amber-200/50 animate-in fade-in slide-in-from-top-2 duration-300">
                        <div className="text-[11px] text-amber-700 mb-2 font-medium">Adiciona uma camada no topo com quantidade diferente de pacotes</div>
                        <div>
                          <FieldLabel>Qtd de pacotes (1-12)</FieldLabel>
                          {editando
                            ? <input type="number" name="camada_final_qtd" min="1" max="12" value={form.camada_final_qtd ?? ''} onChange={handleChange} className={inputCls} />
                            : <Val>{config?.camada_final_qtd}</Val>}
                        </div>
                      </div>
                    )}
                  </div>
                </SectionBlock>

                {/* ── BLOCO 3: RIPAS LATERAIS ── */}
                <SectionBlock title="Proteções Laterais (Quadro)" color="green" number="3">
                  <Row label="Ativar quadro lateral">
                    <Toggle name="ripa_vertical" checked={editando ? form.ripa_vertical : config?.ripa_vertical} editando={editando} onChange={handleChange} />
                  </Row>

                  {(editando ? form.ripa_vertical : config?.ripa_vertical) && (
                    <div className="space-y-4 pt-1 animate-in fade-in slide-in-from-top-2 duration-300">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <FieldLabel>Qtd de colunas</FieldLabel>
                          {editando ? <input type="number" name="num_ripas_lateral" min="2" max="10" value={form.num_ripas_lateral ?? ''} onChange={handleChange} className={inputCls} /> : <Val>{config?.num_ripas_lateral}</Val>}
                        </div>
                        <div>
                          <FieldLabel>Posicionamento</FieldLabel>
                          {editando
                            ? <select name="ripas_lat_posicao" value={form.ripas_lat_posicao} onChange={handleChange} className={inputCls}>
                                <option value="uniforme">Uniforme</option>
                                <option value="cantos">Cantos</option>
                                <option value="centro">Centro</option>
                                <option value="manual">Manual</option>
                              </select>
                            : <Val>{config?.ripas_lat_posicao || 'uniforme'}</Val>}
                        </div>
                      </div>

                      <Divider />
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <FieldLabel>Offset Geral (mm)</FieldLabel>
                          {editando
                            ? <input type="number" name="ripas_lat_offset_mm" value={form.ripas_lat_offset_mm ?? ''} onChange={handleChange} min="-500" max="500" step="10" className={inputCls} />
                            : <Val sufixo="mm">{config?.ripas_lat_offset_mm}</Val>}
                        </div>
                        <div>
                          <FieldLabel>Margem Pontas (mm)</FieldLabel>
                          {editando
                            ? <input type="number" name="ripas_lat_margem_mm" value={form.ripas_lat_margem_mm ?? ''} onChange={handleChange} min="0" max="500" step="10" className={inputCls} />
                            : <Val sufixo="mm">{config?.ripas_lat_margem_mm}</Val>}
                        </div>
                      </div>

                      <Divider />
                      <div className="space-y-3">
                        <div>
                          <FieldLabel>Altura do quadro (mm)</FieldLabel>
                          {editando
                            ? <input type="number" name="ripa_vert_altura_mm" value={form.ripa_vert_altura_mm ?? ''} onChange={handleChange} min="500" max="3000" step="10" className={inputCls} />
                            : <Val sufixo="mm">{config?.ripa_vert_altura_mm ?? 1080}</Val>}
                        </div>
                        <FieldLabel>Seção da ripa (Largura × Espessura)</FieldLabel>
                        <Trio labels={['Larg.(X)', 'Esp.(Z)']} names={['ripa_vert_largura_mm', 'ripa_vert_comp_mm']} min={[5, 5]} max={[100, 100]} twoOnly editando={editando} form={form} handleChange={handleChange} config={config} />
                      </div>
                    </div>
                  )}
                </SectionBlock>

                {/* ── RESUMO (somente leitura) ── */}
                {!editando && config && (() => {
                  const totalCamadas = (config.num_blocos ?? 3) * (config.camadas_por_bloco ?? 3)
                  const totalPacotes = totalCamadas * (config.pacotes_por_camada ?? 3)
                  return (
                    <div className="mx-4 mb-10 bg-slate-900 rounded-2xl p-5 shadow-lg border border-slate-800">
                      <p className="font-black text-white text-xs uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]"></span>
                        Resumo da Carga
                      </p>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-slate-800 rounded-xl p-3 border border-slate-700">
                          <p className="text-[10px] text-slate-400 font-bold uppercase mb-1">Total de Pacotes</p>
                          <p className="text-xl font-black text-emerald-400">{totalPacotes}</p>
                        </div>
                        <div className="bg-slate-800 rounded-xl p-3 border border-slate-700">
                          <p className="text-[10px] text-slate-400 font-bold uppercase mb-1">Ripas Transv.</p>
                          <p className="text-xl font-black text-amber-400">{config.num_ripas_por_camada || 3}</p>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Chip color="green">📐 Lateral: {config.ripa_vertical ? 'Ativa' : 'Off'}</Chip>
                        <Chip color="orange">▲ Topo: {config.ripa_topo ? 'Sim' : 'Não'}</Chip>
                        <Chip color="blue">📏 {config.mostrar_cotas !== false ? 'Cotas Visíveis' : 'Cotas Ocultas'}</Chip>
                      </div>
                    </div>
                  )
                })()}

              </div>

              {/* Botões fixos no rodapé */}
              {editando && (
                <div className="px-5 py-5 flex gap-3 border-t border-slate-200 bg-white shadow-[0_-4px_10px_rgba(0,0,0,0.05)] flex-shrink-0">
                  <button onClick={handleCancelar}
                    className="flex-1 py-3 text-sm border-2 border-slate-200 rounded-xl text-slate-500 hover:bg-slate-50 hover:border-slate-300 font-black uppercase tracking-wider transition-all active:scale-95">
                    Cancelar
                  </button>
                  <button onClick={handleSalvar} disabled={salvando}
                    className="flex-2 py-3 px-8 text-sm bg-amber-500 hover:bg-amber-600 text-white rounded-xl font-black uppercase tracking-wider flex items-center justify-center gap-2 disabled:opacity-50 shadow-md hover:shadow-lg transition-all active:scale-95">
                    <FaSave className="w-4 h-4" />
                    {salvando ? 'Gravando...' : 'Salvar Alterações'}
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 bg-slate-50 overflow-y-auto min-h-0">
            <div className="flex flex-col lg:flex-row gap-4 p-4">
              {/* Coluna esquerda: fila de itens */}
              <div className="flex-1 min-w-[320px] flex flex-col gap-4">
                <section className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                  <div
                    className="p-4 flex items-center justify-between gap-3 bg-amber-50 cursor-pointer select-none hover:bg-amber-100/60 transition-colors"
                    onClick={() => setSecaoItensAberta(v => !v)}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center">
                        <FaCubes className="w-4 h-4" />
                      </div>
                      <div>
                        <p className="text-sm font-black text-slate-800 uppercase tracking-tight flex items-center gap-2">
                          Itens & Paletes
                          {!secaoItensAberta && filaItens.length > 0 && (
                            <span className="px-1.5 py-0.5 rounded-md bg-amber-200 text-amber-800 text-[9px] font-black">{filaItens.length} itens</span>
                          )}
                        </p>
                        <p className="text-[10px] text-slate-500 font-bold uppercase">Selecione para carregar</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleAdicionarPaleteConfigurado() }}
                        disabled={!itemBaseConfigurado}
                        className="text-xs flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-bold transition-all shadow-sm hover:shadow active:scale-95 disabled:opacity-50 disabled:active:scale-100"
                      >
                        <FaPlus className="w-3 h-3" /> Capturar atual
                      </button>
                      <span className="text-slate-400 text-xs font-bold">{secaoItensAberta ? '▲' : '▼'}</span>
                    </div>
                  </div>
                  
                  {secaoItensAberta && <div className="p-4 flex flex-col gap-3 border-t border-slate-100">
                    <div className="max-h-72 overflow-y-auto space-y-2 pr-1 scrollbar-thin scrollbar-thumb-slate-200">
                      {filaItens.length === 0 && (
                        <div className="text-xs text-amber-700 bg-amber-50/50 border border-amber-100 rounded-xl px-4 py-4 text-center font-medium">
                          Nenhum item cadastrado. <br/>Clique em <strong className="font-bold">"Capturar atual"</strong> ou cadastre manualmente.
                        </div>
                      )}
                      {filaItens.map(item => {
                        const selecionado = itemSelecionado && itemSelecionado.id === item.id
                        return (
                          <div
                            key={item.id}
                            onClick={() => handleSelecionarItem(item.id)}
                            className={`rounded-lg border px-2.5 py-2 cursor-pointer transition-all ${selecionado ? 'border-amber-400 bg-amber-50/60 shadow-sm' : 'border-slate-150 bg-white hover:border-amber-200 hover:bg-slate-50/50'}`}
                          >
                            <div className="flex items-center gap-2">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <p className="text-xs font-black text-slate-800 truncate">{item.titulo}</p>
                                  <span className="px-1.5 py-px rounded text-[9px] font-black text-amber-700 bg-amber-100 flex-shrink-0">
                                    {(Number(item.quantidade) || 0)} un
                                  </span>
                                </div>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-[9px] text-slate-400 font-mono">{formatMetros(item.largura)} × {formatMetros(item.comprimento)} × {formatMetros(item.altura)}</span>
                                  <span className="text-[9px] text-slate-400">·</span>
                                  <span className="text-[9px] text-slate-500 font-semibold">{formatVolume(item.volume || ((item.largura || 0) * (item.comprimento || 0) * (item.altura || 0)))}</span>
                                </div>
                              </div>
                              <input
                                type="number"
                                min="0"
                                className="w-12 border border-slate-200 rounded px-1 py-0.5 text-[11px] font-black text-slate-700 bg-white focus:ring-1 focus:ring-amber-300 focus:border-amber-400 transition-all text-center"
                                value={item.quantidade ?? 0}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => handleQuantidadeItemChange(item.id, e.target.value)}
                              />
                              <button
                                className="p-1 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                                onClick={(e) => { e.stopPropagation(); handleRemoverItem(item.id) }}
                              >
                                <FaTrash className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    
                    {/* Resumo Rodapé */}
                    <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-[11px]">
                      <span className="text-slate-500 font-bold uppercase">Fila: <strong className="text-indigo-600 text-sm ml-1">{totalPaletesFila}</strong> un</span>
                      <span className="text-slate-500 font-bold uppercase">Volume: <strong className="text-slate-800 text-sm ml-1">{formatVolume(totalVolumeFila)}</strong></span>
                    </div>
                  </div>}
                </section>

                <section className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                  <div
                    className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50/50 cursor-pointer select-none hover:bg-slate-100/60 transition-colors"
                    onClick={() => setSecaoRomaneiOsAberta(v => !v)}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-xl bg-indigo-100 text-indigo-600 flex items-center justify-center">
                        <FaClipboardList className="w-4 h-4" />
                      </div>
                      <div>
                        <p className="text-sm font-black text-slate-800 uppercase tracking-tight flex items-center gap-2">
                          Romaneios
                          {!secaoRomaneiOsAberta && romaneioPaletesFiltrados.length > 0 && (
                            <span className="px-1.5 py-0.5 rounded-md bg-indigo-100 text-indigo-700 text-[9px] font-black">{romaneioPaletesFiltrados.length} paletes</span>
                          )}
                        </p>
                        <p className="text-[10px] text-slate-500 font-bold uppercase">Paletes conferidos</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <select
                        value={romaneioFiltroStatus}
                        onChange={(e) => setRomaneioFiltroStatus(e.target.value)}
                        className="border border-slate-300 rounded-lg text-[10px] font-bold uppercase px-3 py-2 bg-white focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none"
                      >
                        <option value="conferido">Conferidos</option>
                        <option value="expedido">Expedidos</option>
                        <option value="todos">Todos</option>
                      </select>
                      <button
                        onClick={fetchRomaneiosDisponiveis}
                        className="flex items-center justify-center w-8 h-8 rounded-lg border border-slate-300 bg-white text-slate-500 hover:text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50 transition-all"
                        title="Atualizar"
                      >
                        <FaSync className={`w-3.5 h-3.5 ${romaneioLoading ? 'animate-spin text-indigo-600' : ''}`} />
                      </button>
                    </div>
                    <span className="text-slate-400 text-xs font-bold self-center">{secaoRomaneiOsAberta ? '▲' : '▼'}</span>
                  </div>
                  
                  {secaoRomaneiOsAberta && <div className="p-4 flex flex-col gap-3 border-t border-slate-100">
                    {/* Filtros avançados */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {/* Busca geral */}
                      <div className="relative">
                        <FaSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-3.5 h-3.5" />
                        <input
                          type="text"
                          value={romaneioFiltroBusca}
                          onChange={(e) => setRomaneioFiltroBusca(e.target.value)}
                          placeholder="Buscar rack, cliente, produto..."
                          className="w-full border border-slate-300 rounded-lg pl-9 pr-3 py-2 text-xs font-medium bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 transition-all placeholder:text-slate-400"
                        />
                      </div>
                      {/* Filtro por Romaneio */}
                      <select
                        value={romaneioFiltroNumero}
                        onChange={(e) => setRomaneioFiltroNumero(e.target.value)}
                        className="border border-slate-300 rounded-lg text-xs font-medium px-3 py-2 bg-white focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none"
                      >
                        <option value="">Todos os Romaneios</option>
                        {romaneioNumerosUnicos.map(({ numero, cliente }) => (
                          <option key={numero} value={numero}>{numero} · {cliente}</option>
                        ))}
                      </select>
                    </div>

                    {/* Modo de seleção e ações em massa */}
                    <div className="flex flex-wrap items-center gap-2 bg-slate-50 rounded-lg p-2 border border-slate-200">
                      <span className="text-[10px] font-bold text-slate-500 uppercase">Selecionar:</span>
                      <select
                        value={romaneioModoSelecao}
                        onChange={(e) => { setRomaneioModoSelecao(e.target.value); setRomaneioSelecionados(new Set()) }}
                        className="border border-slate-300 rounded text-[10px] font-bold uppercase px-2 py-1 bg-white focus:ring-1 focus:ring-indigo-200 focus:border-indigo-400 outline-none"
                      >
                        <option value="rack">Por Rack (um a um)</option>
                        <option value="romaneio">Por Romaneio (todos)</option>
                        <option value="cliente">Por Cliente</option>
                        <option value="pedido">Por Pedido Cliente</option>
                      </select>
                      
                      <div className="w-px h-5 bg-slate-300 mx-1" />
                      
                      <button
                        onClick={toggleSelecionarTodos}
                        className="text-[10px] font-bold uppercase px-2 py-1 rounded bg-white border border-slate-300 text-slate-600 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-600 transition-all"
                      >
                        {romaneioPaletesFiltrados.every(e => romaneioSelecionados.has(e.key)) ? 'Desmarcar Todos' : 'Selecionar Todos'}
                      </button>
                      
                      {romaneioSelecionados.size > 0 && (
                        <>
                          <span className="text-[10px] text-slate-400">({romaneioSelecionados.size} selecionados)</span>
                          <button
                            onClick={adicionarSelecionados}
                            className="text-[10px] font-bold uppercase px-3 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 transition-all flex items-center gap-1"
                          >
                            <FaPlus className="w-3 h-3" /> Adicionar {romaneioSelecionados.size} à Fila
                          </button>
                        </>
                      )}
                    </div>
                    
                    {romaneioErro && (
                      <div className="text-[10px] font-bold text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 uppercase text-center">{romaneioErro}</div>
                    )}
                    
                    <div className="max-h-72 overflow-y-auto space-y-2 pr-1 scrollbar-thin scrollbar-thumb-slate-200">
                      {romaneioLoading ? (
                        <div className="text-xs text-slate-400 font-bold uppercase text-center py-4 animate-pulse">Buscando...</div>
                      ) : romaneioPaletesFiltrados.length === 0 ? (
                        <div className="text-[11px] text-slate-500 bg-slate-50 rounded-xl px-4 py-4 text-center font-medium border border-slate-100">
                          Nenhum palete encontrado para este filtro.
                        </div>
                      ) : (
                        romaneioPaletesFiltrados.map((entrada) => {
                          const dims = romaneioDimensoes[entrada.key] || { largura: '', comprimento: '', altura: '', quantidade: '1' }
                          const erroDim = romaneioDimensoesErro[entrada.key]
                          const jaAdicionado = filaItens.some(item => item.metadataRomaneio?.key === entrada.key)
                          const statusLabel = entrada.romaneioStatus === 'expedido' ? 'Expedido' : 'Conferido'
                          const completudeInfo = calcularCompletudePalete(entrada)
                          const isSelecionado = romaneioSelecionados.has(entrada.key)
                          
                          return (
                            <div key={entrada.key} className={`border rounded-lg bg-white relative overflow-hidden transition-all ${jaAdicionado ? 'border-emerald-200 bg-emerald-50/30' : isSelecionado ? 'border-indigo-300 bg-indigo-50/30' : 'border-slate-200 hover:border-slate-300'}`}>
                              <div className={`absolute top-0 left-0 w-0.5 h-full ${entrada.romaneioStatus === 'expedido' ? 'bg-indigo-400' : completudeInfo && !completudeInfo.completo ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                              
                              {/* Header compacto */}
                              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 pl-3">
                                <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                                  {/* Checkbox para seleção */}
                                  <input
                                    type="checkbox"
                                    checked={isSelecionado}
                                    onChange={() => {
                                      setRomaneioSelecionados(prev => {
                                        const novo = new Set(prev)
                                        if (novo.has(entrada.key)) {
                                          novo.delete(entrada.key)
                                        } else {
                                          novo.add(entrada.key)
                                        }
                                        return novo
                                      })
                                    }}
                                    className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                                  />
                                  <p className="text-xs font-black text-slate-800 truncate">{entrada.rack}</p>
                                  {entrada.produtos?.[0] && (
                                    <span className="px-1.5 py-px bg-blue-100 text-blue-700 text-[8px] font-black rounded flex-shrink-0">
                                      {entrada.produtos[0]}
                                    </span>
                                  )}
                                  <span className={`px-1 py-px text-[7px] font-black uppercase rounded flex-shrink-0 ${entrada.romaneioStatus === 'expedido' ? 'bg-indigo-100 text-indigo-700' : 'bg-emerald-100 text-emerald-700'}`}>
                                    {statusLabel}
                                  </span>
                                  {completudeInfo && (
                                    <span className={`px-1.5 py-px text-[7px] font-black rounded flex-shrink-0 ${completudeInfo.completo ? 'bg-emerald-100 text-emerald-700' : completudeInfo.percentual >= 75 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                                      {completudeInfo.percentual}% · {completudeInfo.amarradosRack}/{completudeInfo.amarradosPalete} am.
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 flex-shrink-0 text-[9px]">
                                  <span className="text-slate-400 font-bold">{entrada.quantidadePecas.toLocaleString('pt-BR')} pçs</span>
                                  {entrada.comprimentoAcabadoMm > 0 && <span className="text-amber-600 font-black">{entrada.comprimentoAcabadoMm}mm</span>}
                                </div>
                              </div>
                              
                              {/* Info + Dims numa linha compacta */}
                              <div className="px-2.5 pb-1.5 pl-3 flex items-center gap-1.5">
                                <span className="text-[9px] text-slate-400 truncate flex-1 min-w-0">{entrada.romaneioNumero} · {entrada.clientes.length ? entrada.clientes[0] : entrada.romaneioCliente || '—'}</span>
                                <div className="flex items-end gap-1 flex-shrink-0">
                                  <div className="flex flex-col items-center gap-0.5">
                                    <span className="text-[7px] font-bold text-slate-400 uppercase">Larg</span>
                                    <input type="text" value={dims.largura} onChange={(e) => handleRomaneioDimensaoChange(entrada.key, 'largura', e.target.value)} placeholder="0.00" title="Largura do palete (m)" className="w-12 border border-slate-200 rounded px-1 py-0.5 text-[10px] text-center focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 outline-none" />
                                  </div>
                                  <span className="text-slate-300 text-[9px] mb-1">×</span>
                                  <div className="flex flex-col items-center gap-0.5">
                                    <span className="text-[7px] font-bold text-slate-400 uppercase">Comp</span>
                                    <input type="text" value={dims.comprimento} onChange={(e) => handleRomaneioDimensaoChange(entrada.key, 'comprimento', e.target.value)} placeholder="0.00" title="Comprimento do material (m)" className={`w-12 rounded px-1 py-0.5 text-[10px] text-center outline-none ${entrada.comprimentoAcabadoMm > 0 ? 'border border-amber-300 bg-amber-50/60 focus:ring-1 focus:ring-amber-200' : 'border border-slate-200 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100'}`} />
                                  </div>
                                  <span className="text-slate-300 text-[9px] mb-1">×</span>
                                  <div className="flex flex-col items-center gap-0.5">
                                    <span className="text-[7px] font-bold text-slate-400 uppercase">Alt</span>
                                    <input type="text" value={dims.altura} onChange={(e) => handleRomaneioDimensaoChange(entrada.key, 'altura', e.target.value)} placeholder="0.00" title="Altura total do palete (m)" className="w-12 border border-slate-200 rounded px-1 py-0.5 text-[10px] text-center focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 outline-none" />
                                  </div>
                                  <div className="flex flex-col items-center gap-0.5">
                                    <span className="text-[7px] font-bold text-slate-400 uppercase">Qtd</span>
                                    <input type="number" min="1" value={dims.quantidade || '1'} onChange={(e) => handleRomaneioDimensaoChange(entrada.key, 'quantidade', e.target.value)} title="Quantidade de paletes" className="w-9 border border-slate-200 rounded px-1 py-0.5 text-[10px] font-bold text-center focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 outline-none" />
                                  </div>
                                  <button
                                    onClick={() => handleAdicionarRomaneioPalete(entrada)}
                                    disabled={jaAdicionado}
                                    className={`mb-0 px-2 py-1 rounded text-[9px] font-black uppercase tracking-wider transition-all flex-shrink-0 self-end ${jaAdicionado ? 'bg-emerald-100 text-emerald-500 cursor-not-allowed' : 'bg-slate-800 text-white hover:bg-indigo-600 active:scale-95'}`}
                                  >
                                    {jaAdicionado ? '✓' : '+'}
                                  </button>
                                </div>
                              </div>
                              {erroDim && <p className="text-[8px] font-bold text-red-500 text-center pb-1">{erroDim}</p>}
                            </div>
                          )
                        })
                      )}
                    </div>
                  </div>}
                </section>

                <section className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                  <div
                    className="p-3 flex items-center justify-between gap-2 bg-slate-50/50 cursor-pointer select-none hover:bg-slate-100/60 transition-colors"
                    onClick={() => setSecaoManualAberta(v => !v)}
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-lg bg-slate-200 text-slate-600 flex items-center justify-center">
                        <FaEdit className="w-3 h-3" />
                      </div>
                      <p className="text-[11px] font-black text-slate-700 uppercase tracking-tight">Cadastro Manual Extra</p>
                    </div>
                    <span className="text-slate-400 text-xs font-bold">{secaoManualAberta ? '▲' : '▼'}</span>
                  </div>
                  {secaoManualAberta && <div className="p-4 space-y-3 border-t border-slate-100">
                    {/* Toggle modo */}
                    <div className="flex rounded-lg overflow-hidden border border-slate-200 text-[10px] font-black uppercase">
                      <button
                        onClick={() => setModoManual('cadastrado')}
                        className={`flex-1 py-1.5 transition-colors ${modoManual === 'cadastrado' ? 'bg-slate-800 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
                      >
                        📦 Palete cadastrado
                      </button>
                      <button
                        onClick={() => setModoManual('livre')}
                        className={`flex-1 py-1.5 transition-colors ${modoManual === 'livre' ? 'bg-slate-800 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
                      >
                        ✏️ Dimensões livres
                      </button>
                    </div>

                    {/* Seletor de palete cadastrado */}
                    {modoManual === 'cadastrado' && (() => {
                      const ferramentasUnicas = [...new Map(
                        paleteConfigData.map(c => [String(c.ferramenta).toUpperCase(), c.ferramenta])
                      ).entries()].sort((a, b) => a[0].localeCompare(b[0]))
                      const ferrSel = novoItemPaleteSel.split('|')[0] || ''
                      const compSel = novoItemPaleteSel.split('|')[1] || ''
                      const comprimentosParaFerr = paleteConfigData
                        .filter(c => String(c.ferramenta).toUpperCase() === ferrSel.toUpperCase())
                        .sort((a, b) => Number(a.comprimento_mm || 0) - Number(b.comprimento_mm || 0))
                      return (
                        <div className="space-y-2">
                          <div className="relative">
                            <span className="absolute -top-1.5 left-2 bg-white px-1 text-[8px] font-black text-slate-400 uppercase">Ferramenta</span>
                            <select
                              value={ferrSel}
                              onChange={(e) => {
                                const ferr = e.target.value
                                setNovoItemPaleteSel(ferr ? `${ferr}|` : '')
                                setNovoItem(prev => ({ ...prev, titulo: ferr || prev.titulo }))
                              }}
                              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs font-bold bg-white focus:border-slate-500 focus:ring-1 focus:ring-slate-200 outline-none"
                            >
                              <option value="">— Selecione a ferramenta —</option>
                              {ferramentasUnicas.map(([key, val]) => (
                                <option key={key} value={key}>{val}</option>
                              ))}
                            </select>
                          </div>
                          {ferrSel && (
                            <div className="relative">
                              <span className="absolute -top-1.5 left-2 bg-white px-1 text-[8px] font-black text-slate-400 uppercase">Comprimento</span>
                              <select
                                value={compSel}
                                onChange={(e) => {
                                  const comp = e.target.value
                                  const chave = `${ferrSel}|${comp}`
                                  setNovoItemPaleteSel(chave)
                                  const cfg = paleteConfigData.find(c =>
                                    String(c.ferramenta).toUpperCase() === ferrSel.toUpperCase() &&
                                    String(c.comprimento_mm || '') === comp
                                  )
                                  if (cfg) {
                                    const dims = calcularDimensoesDaConfig(cfg)
                                    if (dims) {
                                      setNovoItem(prev => ({
                                        ...prev,
                                        titulo: comp ? `${ferrSel} · ${comp}mm` : ferrSel,
                                        largura: dims.largura,
                                        comprimento: dims.comprimento,
                                        altura: dims.altura,
                                      }))
                                    }
                                  }
                                }}
                                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs font-bold bg-white focus:border-slate-500 focus:ring-1 focus:ring-slate-200 outline-none"
                              >
                                <option value="">— Selecione o comprimento —</option>
                                {comprimentosParaFerr.map(c => (
                                  <option key={c.comprimento_mm ?? 'default'} value={String(c.comprimento_mm || '')}>
                                    {c.comprimento_mm ? `${c.comprimento_mm} mm` : 'Padrão (sem comprimento)'}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                          {novoItemPaleteSel && novoItem.largura && (
                            <div className="flex gap-3 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-[10px] font-bold text-slate-600">
                              <span>L: <strong>{novoItem.largura}m</strong></span>
                              <span>×</span>
                              <span>C: <strong>{novoItem.comprimento}m</strong></span>
                              <span>×</span>
                              <span>A: <strong>{novoItem.altura}m</strong></span>
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* Campos comuns */}
                    <div className="grid grid-cols-5 gap-2">
                      <div className="col-span-5 sm:col-span-4 relative">
                        <span className="absolute -top-1.5 left-2 bg-white px-1 text-[8px] font-black text-slate-400 uppercase">Descrição</span>
                        <input name="titulo" value={novoItem.titulo} onChange={handleNovoItemChange} placeholder="Ex: Caixa avulsa" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs font-medium focus:border-slate-500 focus:ring-1 focus:ring-slate-200 outline-none" />
                      </div>
                      <div className="col-span-5 sm:col-span-1 relative">
                        <span className="absolute -top-1.5 left-2 bg-white px-1 text-[8px] font-black text-slate-400 uppercase">Qtd</span>
                        <input name="quantidade" value={novoItem.quantidade} onChange={handleNovoItemChange} type="number" min="1" className="w-full border border-slate-300 rounded-lg px-2 py-2 text-xs font-bold text-center focus:border-slate-500 focus:ring-1 focus:ring-slate-200 outline-none" />
                      </div>
                      <div className="col-span-5 sm:col-span-2 relative">
                        <span className="absolute -top-1.5 left-2 bg-white px-1 text-[8px] font-black text-slate-400 uppercase">Larg (m)</span>
                        <input name="largura" value={novoItem.largura} onChange={handleNovoItemChange} readOnly={modoManual === 'cadastrado'} className={`w-full border rounded-lg px-3 py-2 text-xs font-medium text-center focus:ring-1 outline-none ${modoManual === 'cadastrado' ? 'bg-slate-50 border-slate-200 text-slate-500 cursor-default' : 'border-slate-300 focus:border-slate-500 focus:ring-slate-200'}`} />
                      </div>
                      <div className="col-span-5 sm:col-span-2 relative">
                        <span className="absolute -top-1.5 left-2 bg-white px-1 text-[8px] font-black text-slate-400 uppercase">Comp (m)</span>
                        <input name="comprimento" value={novoItem.comprimento} onChange={handleNovoItemChange} readOnly={modoManual === 'cadastrado'} className={`w-full border rounded-lg px-3 py-2 text-xs font-medium text-center focus:ring-1 outline-none ${modoManual === 'cadastrado' ? 'bg-slate-50 border-slate-200 text-slate-500 cursor-default' : 'border-slate-300 focus:border-slate-500 focus:ring-slate-200'}`} />
                      </div>
                      <div className="col-span-5 sm:col-span-1 relative">
                        <span className="absolute -top-1.5 left-2 bg-white px-1 text-[8px] font-black text-slate-400 uppercase">Alt (m)</span>
                        <input name="altura" value={novoItem.altura} onChange={handleNovoItemChange} readOnly={modoManual === 'cadastrado'} className={`w-full border rounded-lg px-3 py-2 text-xs font-medium text-center focus:ring-1 outline-none ${modoManual === 'cadastrado' ? 'bg-slate-50 border-slate-200 text-slate-500 cursor-default' : 'border-slate-300 focus:border-slate-500 focus:ring-slate-200'}`} />
                      </div>
                    </div>
                    {novoItemErro && <p className="text-[10px] font-bold text-red-500 uppercase text-center bg-red-50 py-1 rounded">{novoItemErro}</p>}
                    <button onClick={handleAdicionarItemManual} className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-900 text-white text-[11px] font-black uppercase tracking-wider flex items-center justify-center gap-2 transition-all shadow-sm active:scale-95">
                      <FaPlus className="w-3 h-3" /> Adicionar à Fila
                    </button>
                  </div>}
                </section>
              </div>

              {/* Coluna direita: caminhões e simulação */}
              <div className="flex-1 min-w-[400px] flex flex-col gap-4">
                {/* Dashboard de Ocupação Rápida */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="bg-slate-900 rounded-2xl p-4 shadow-lg border border-slate-800">
                    <p className="text-[10px] text-slate-400 font-black uppercase tracking-wider mb-1">Paletes no Baú</p>
                    <div className="flex items-baseline gap-1">
                      <span className="text-2xl font-black text-emerald-400">{simulacaoAtual?.capacidadeTotal || 0}</span>
                      <span className="text-xs text-slate-500 font-bold">un</span>
                    </div>
                  </div>
                  <div className="bg-slate-900 rounded-2xl p-4 shadow-lg border border-slate-800">
                    <p className="text-[10px] text-slate-400 font-black uppercase tracking-wider mb-1">Volume Ocupado</p>
                    <div className="flex items-center gap-3">
                      <span className="text-2xl font-black text-amber-400">{Math.round((simulacaoAtual?.ocupacaoVolume || 0) * 100)}%</span>
                      <div className="flex-1 h-2 rounded-full bg-slate-800 overflow-hidden">
                        <div className="h-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]" style={{ width: `${Math.min(100, Math.round((simulacaoAtual?.ocupacaoVolume || 0) * 100))}%` }} />
                      </div>
                    </div>
                  </div>
                  <div className="bg-slate-900 rounded-2xl p-4 shadow-lg border border-slate-800">
                    <p className="text-[10px] text-slate-400 font-black uppercase tracking-wider mb-1">Total na Fila</p>
                    <div className="flex items-baseline gap-1">
                      <span className="text-2xl font-black text-indigo-400">{totalPaletesFila}</span>
                      <span className="text-xs text-slate-500 font-bold">un</span>
                    </div>
                  </div>
                  <div className="bg-slate-900 rounded-2xl p-4 shadow-lg border border-slate-800">
                    <p className="text-[10px] text-slate-400 font-black uppercase tracking-wider mb-1">Viagens Estimadas</p>
                    <div className="flex items-baseline gap-1">
                      <span className="text-2xl font-black text-white">{viagensNecessarias || '—'}</span>
                    </div>
                  </div>
                </div>

                <section className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="p-4 border-b border-slate-100 flex items-center justify-between gap-3 bg-slate-50/50">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-xl bg-slate-200 text-slate-600 flex items-center justify-center">
                        <FaTruckLoading className="w-4 h-4" />
                      </div>
                      <div>
                        <p className="text-sm font-black text-slate-800 uppercase tracking-tight">Escolha o tipo de caminhão</p>
                        <p className="text-[10px] text-slate-500 font-bold uppercase">Define o espaço útil</p>
                      </div>
                    </div>
                    <button
                      onClick={() => setCaminhoesExpandido(v => !v)}
                      className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 text-slate-600 transition-all shadow-sm"
                      title={caminhoesExpandido ? 'Recolher lista' : 'Expandir lista'}
                    >
                      {caminhoesExpandido ? '▲ Recolher' : '▼ Expandir'}
                      <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">({CAMINHOES_SIMULACAO.length})</span>
                    </button>
                  </div>

                  <div className="p-4 bg-white">
                    {/* Resumo compacto quando recolhido */}
                    {!caminhoesExpandido && (
                      <div className="flex items-center gap-4 p-4 rounded-xl border border-slate-200 bg-slate-50 group hover:border-slate-300 transition-colors">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <p className="text-sm font-black text-slate-800 uppercase tracking-tight">{caminhaoAtual.titulo}</p>
                            <span className="text-[10px] font-bold px-2 py-0.5 bg-white border border-slate-200 rounded text-slate-500">{caminhaoAtual.subtitulo}</span>
                          </div>
                          <div className="flex gap-4 text-[11px] font-mono text-slate-600">
                            <span className="flex items-center gap-1"><strong className="text-slate-400 font-sans uppercase">C:</strong>{caminhaoAtual.comprimento}m</span>
                            <span className="flex items-center gap-1 border-l pl-4 border-slate-300"><strong className="text-slate-400 font-sans uppercase">L:</strong>{caminhaoAtual.largura}m</span>
                            <span className="flex items-center gap-1 border-l pl-4 border-slate-300"><strong className="text-slate-400 font-sans uppercase">A:</strong>{caminhaoAtual.altura}m</span>
                          </div>
                        </div>
                        <button
                          onClick={() => setCaminhoesExpandido(true)}
                          className="text-[10px] font-black uppercase tracking-wider px-4 py-2 rounded-lg bg-white border border-slate-300 text-slate-600 hover:bg-slate-800 hover:text-white hover:border-slate-800 transition-all shadow-sm"
                        >
                          Trocar Caminhão
                        </button>
                      </div>
                    )}

                    {/* Lista completa quando expandido */}
                    {caminhoesExpandido && (
                      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[360px] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-slate-200">
                        {CAMINHOES_SIMULACAO.map(cam => {
                          const ativo = caminhaoSelecionado === cam.id
                          return (
                            <button
                              key={cam.id}
                              onClick={() => {
                                setCaminhaoSelecionado(cam.id)
                                setCaminhoesExpandido(false)
                              }}
                              className={`text-left rounded-xl border p-4 transition-all group ${ativo ? 'border-slate-800 bg-slate-800 shadow-md ring-2 ring-slate-800/20' : 'border-slate-200 bg-white hover:border-slate-400 hover:bg-slate-50 hover:shadow-sm'}`}
                            >
                              <div className="flex items-center justify-between mb-1">
                                <p className={`text-sm font-black uppercase tracking-tight ${ativo ? 'text-white' : 'text-slate-800'}`}>{cam.titulo}</p>
                                {ativo && <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />}
                              </div>
                              <p className={`text-[10px] font-bold uppercase mb-3 ${ativo ? 'text-slate-300' : 'text-slate-500'}`}>{cam.subtitulo}</p>
                              
                              <div className={`grid grid-cols-3 gap-1 p-2 rounded-lg text-[10px] font-mono text-center ${ativo ? 'bg-slate-900/50 text-slate-300' : 'bg-slate-100 text-slate-600 group-hover:bg-white border border-slate-200/50'}`}>
                                <span className="flex flex-col"><span className={`text-[8px] font-sans uppercase ${ativo ? 'text-slate-500' : 'text-slate-400'}`}>Comp</span>{cam.comprimento}</span>
                                <span className={`flex flex-col border-l ${ativo ? 'border-slate-700' : 'border-slate-200'}`}><span className={`text-[8px] font-sans uppercase ${ativo ? 'text-slate-500' : 'text-slate-400'}`}>Larg</span>{cam.largura}</span>
                                <span className={`flex flex-col border-l ${ativo ? 'border-slate-700' : 'border-slate-200'}`}><span className={`text-[8px] font-sans uppercase ${ativo ? 'text-slate-500' : 'text-slate-400'}`}>Alt</span>{cam.altura}</span>
                              </div>
                              <p className={`text-[9px] mt-3 font-medium leading-relaxed ${ativo ? 'text-slate-400' : 'text-slate-500'}`}>{cam.observacao}</p>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </section>

                <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-0 overflow-hidden">
                  <div className="p-4 border-b border-slate-100 flex items-center justify-between gap-3 bg-slate-50/50">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-xl bg-indigo-100 text-indigo-600 flex items-center justify-center">
                        <FaTruckLoading className="w-4 h-4" />
                      </div>
                      <div>
                        <p className="text-sm font-black text-slate-800 uppercase tracking-tight">Simulação da carga</p>
                        <p className="text-[10px] text-slate-400 font-bold uppercase">{caminhaoAtual.titulo} · {caminhaoAtual.comprimento}m</p>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-3">
                      {/* Modo toggle: Automático / Manual */}
                      <div className="flex items-center gap-1 p-0.5 bg-slate-100 border border-slate-200 rounded-lg">
                        <button
                          onClick={() => setModoCubagem('automatico')}
                          className={`px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-wider transition-all ${modoCubagem === 'automatico' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                        >
                          Automático
                        </button>
                        <button
                          onClick={() => setModoCubagem('manual')}
                          className={`px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-wider transition-all ${modoCubagem === 'manual' ? 'bg-white text-amber-700 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                        >
                          Manual
                        </button>
                      </div>

                      {/* View mode buttons - only for auto mode */}
                      {modoCubagem === 'automatico' && (
                        <div className="flex items-center gap-1.5 p-1 bg-white border border-slate-200 rounded-xl shadow-sm">
                          {[
                            { id: 'isometrico', label: '3D' },
                            { id: 'lateral', label: 'Lateral' },
                            { id: 'frontal', label: 'Front' },
                            { id: 'topo', label: 'Topo' },
                            { id: 'livre', label: 'Livre' },
                          ].map((modo) => (
                            <button
                              key={modo.id}
                              onClick={() => setTruckViewMode(modo.id)}
                              className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all ${truckViewMode === modo.id ? 'bg-slate-900 text-white shadow-md' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
                            >
                              {modo.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {modoCubagem === 'automatico' ? (
                    <div className="relative aspect-video lg:aspect-auto lg:h-[400px] bg-slate-900">
                      <TruckPreview3D
                        caminhao={caminhaoAtual}
                        filaItens={filaItens}
                        folgaPerimetroCm={folgaPerimetroCm}
                        folgaAlturaCm={folgaAlturaCm}
                        considerarAltura={considerarAltura}
                        viewMode={truckViewMode}
                      />
                      
                      {totalPesoCargaKg != null && (
                        <div className="absolute top-4 left-4 pointer-events-none">
                          <div className="bg-slate-900/80 backdrop-blur-md border border-slate-700 rounded-xl px-3 py-2 shadow-2xl">
                            <p className="text-[9px] text-slate-400 font-black uppercase tracking-widest mb-0.5">Peso Estimado</p>
                            <p className="text-lg font-black text-white">
                              {totalPesoCargaKg >= 1000
                                ? `${(totalPesoCargaKg / 1000).toFixed(2)} t`
                                : `${totalPesoCargaKg.toFixed(0)} kg`}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="p-4 space-y-4">
                      {/* Editor 2D manual */}
                      <TruckManualEditor2D
                        caminhao={caminhaoAtual}
                        filaItens={filaItens}
                        folgaPerimetroCm={folgaPerimetroCm}
                        folgaAlturaCm={folgaAlturaCm}
                        considerarAltura={considerarAltura}
                        onPlacementsChange={(pl) => setManualPlacements(pl)}
                        initialPlacements={loadedPlacements}
                      />
                      {/* Mini 3D preview do posicionamento manual */}
                      {manualPlacements.length > 0 && (
                        <div className="rounded-xl border border-slate-200 overflow-hidden">
                          <div className="bg-slate-800 px-3 py-1.5 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-bold text-slate-400 uppercase">Preview 3D</span>
                              <button onClick={() => setShowFolgas(v => !v)}
                                className={`text-[9px] font-bold px-2 py-0.5 rounded transition-all ${showFolgas ? 'bg-amber-500 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'}`}>
                                ↕ Folgas
                              </button>
                            </div>
                            <div className="flex items-center gap-3">
                              {showFolgas && (() => {
                                const altCam = caminhaoAtual.altura
                                const folgaAltVal = Math.max(0, Number(folgaAlturaCm) || 0) / 100
                                const tetoUtil = altCam - folgaAltVal
                                const menorFolga = manualPlacements.reduce((min, p) => {
                                  const topo = (p.yCalc || 0) + p.alt
                                  return Math.min(min, tetoUtil - topo)
                                }, tetoUtil)
                                const maiorTopo = manualPlacements.reduce((max, p) => Math.max(max, (p.yCalc || 0) + p.alt), 0)
                                return (
                                  <span className={`text-[10px] font-bold ${menorFolga < 0.3 ? 'text-red-400' : menorFolga < 0.6 ? 'text-amber-400' : 'text-emerald-400'}`}>
                                    Min: {(menorFolga * 100).toFixed(0)}cm · Livre: {((tetoUtil - maiorTopo) * 100).toFixed(0)}cm
                                  </span>
                                )
                              })()}
                              <span className="text-[10px] text-slate-500">{manualPlacements.length} paletes</span>
                            </div>
                          </div>
                          <div className="h-56 bg-slate-900">
                            <Canvas shadows gl={{ powerPreference: 'low-power', antialias: false }} onCreated={({ gl }) => {
                              const canvas = gl.domElement
                              canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault() })
                              canvas.addEventListener('webglcontextrestored', () => { gl.forceContextRestore?.() })
                            }}>
                              <PerspectiveCamera makeDefault fov={45} position={[
                                Math.max(8, caminhaoAtual.comprimento * 0.6),
                                Math.max(6, caminhaoAtual.altura * 1.6 + 2),
                                Math.max(8, caminhaoAtual.largura * 1.0 + 4),
                              ]} />
                              <color attach="background" args={['#0f172a']} />
                              <ambientLight intensity={0.9} />
                              <directionalLight position={[5, 8, 5]} intensity={0.8} />
                              <group>
                                {(() => {
                                  const baseDim = Math.max(caminhaoAtual.comprimento, caminhaoAtual.largura, 1)
                                  const sc = 8 / baseDim
                                  const len = caminhaoAtual.comprimento * sc
                                  const wid = caminhaoAtual.largura * sc
                                  const hei = caminhaoAtual.altura * sc
                                  const fLin = Math.max(0, Number(folgaPerimetroCm) || 0) / 100
                                  const lU = Math.max(0, caminhaoAtual.largura - fLin * 2)
                                  const folgaAltVal = Math.max(0, Number(folgaAlturaCm) || 0) / 100
                                  const tetoUtil = caminhaoAtual.altura - folgaAltVal
                                  return (
                                    <>
                                      <mesh rotation={[-Math.PI / 2, 0, 0]}>
                                        <planeGeometry args={[len, wid]} />
                                        <meshStandardMaterial color="#1e3a8a" opacity={0.5} transparent />
                                      </mesh>
                                      <mesh position={[0, hei / 2, 0]}>
                                        <boxGeometry args={[len, hei, wid]} />
                                        <meshStandardMaterial color="#38bdf8" transparent opacity={0.08} depthWrite={false} side={DoubleSide} />
                                        <Edges scale={1.001} color="#38bdf8" />
                                      </mesh>
                                      {manualPlacements.map(p => (
                                        <mesh key={p.id} position={[
                                          (-caminhaoAtual.comprimento / 2 + fLin + p.x + p.w / 2) * sc,
                                          ((p.yCalc || 0) + p.alt / 2) * sc,
                                          (-lU / 2 + p.z + p.d / 2) * sc,
                                        ]}>
                                          <boxGeometry args={[p.w * sc * 0.97, p.alt * sc * 0.97, p.d * sc * 0.97]} />
                                          <meshStandardMaterial color={p.cor} opacity={0.9} transparent />
                                        </mesh>
                                      ))}
                                      {/* Folga indicators: only for top-level pallets (nothing stacked above) */}
                                      {showFolgas && manualPlacements.filter(p => {
                                        const topoP = (p.yCalc || 0) + p.alt
                                        // Check if any other pallet sits above this one (overlapping in x/z)
                                        return !manualPlacements.some(o => {
                                          if (o.id === p.id) return false
                                          const oBase = o.yCalc || 0
                                          if (oBase < topoP - 0.001) return false // not above
                                          // Check x/z overlap
                                          const overlapX = p.x < o.x + o.w && p.x + p.w > o.x
                                          const overlapZ = p.z < o.z + o.d && p.z + p.d > o.z
                                          return overlapX && overlapZ
                                        })
                                      }).map(p => {
                                        const topoP = ((p.yCalc || 0) + p.alt)
                                        const folgaCm = ((tetoUtil - topoP) * 100).toFixed(0)
                                        const cx = (-caminhaoAtual.comprimento / 2 + fLin + p.x + p.w / 2) * sc
                                        const cz = (-lU / 2 + p.z + p.d / 2) * sc
                                        const yBottom = topoP * sc
                                        const yTop = tetoUtil * sc
                                        if (topoP >= tetoUtil) return null
                                        return (
                                          <group key={p.id + '_folga'}>
                                            <Line
                                              points={[[cx, yBottom, cz], [cx, yTop, cz]]}
                                              color={Number(folgaCm) < 30 ? '#ef4444' : Number(folgaCm) < 60 ? '#f59e0b' : '#22c55e'}
                                              lineWidth={2}
                                              dashed
                                              dashSize={0.15}
                                              gapSize={0.1}
                                            />
                                            <Html position={[cx, (yBottom + yTop) / 2, cz]} center
                                              style={{ pointerEvents: 'none' }}>
                                              <div className="bg-black/80 text-white text-[8px] font-bold px-1 py-0.5 rounded whitespace-nowrap"
                                                style={{ color: Number(folgaCm) < 30 ? '#fca5a5' : Number(folgaCm) < 60 ? '#fde68a' : '#86efac' }}>
                                                ↕ {folgaCm}cm
                                              </div>
                                            </Html>
                                          </group>
                                        )
                                      })}
                                    </>
                                  )
                                })()}
                              </group>
                              <OrbitControls enablePan={false} enableDamping />
                            </Canvas>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </section>

                {/* ─── AÇÕES: SALVAR / CARREGAR / IMPRIMIR ─── */}
                <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-2">
                      <FaSave className="text-slate-400 w-4 h-4" />
                      <span className="text-xs font-black text-slate-600 uppercase tracking-tight">
                        {simulacaoCarregadaId ? 'Simulação salva' : 'Salvar simulação'}
                      </span>
                      {simulacaoCarregadaId && <FaCheck className="text-emerald-500 w-3 h-3" />}
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => { setSimForm(f => ({ ...f, titulo: f.titulo || `Carga ${caminhaoAtual.titulo} - ${new Date().toLocaleDateString('pt-BR')}` })); setShowSalvarModal(true) }}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 hover:border-emerald-400 text-xs font-bold text-emerald-700 transition-all">
                        <FaSave className="w-3 h-3" /> Salvar
                      </button>
                      <button onClick={() => { carregarListaSimulacoes(); setShowCarregarModal(true) }}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 hover:border-indigo-400 text-xs font-bold text-indigo-700 transition-all">
                        <FaFolderOpen className="w-3 h-3" /> Carregar
                      </button>
                      <button onClick={imprimirRelatorio}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 hover:border-slate-400 text-xs font-bold text-slate-700 transition-all">
                        <FaPrint className="w-3 h-3" /> Imprimir
                      </button>
                    </div>
                  </div>
                </section>

                {/* ─── MODAL: SALVAR SIMULAÇÃO ─── */}
                {showSalvarModal && (
                  <div className="fixed inset-0 z-[80] flex items-center justify-center">
                    <div className="absolute inset-0 bg-black/40" onClick={() => setShowSalvarModal(false)} />
                    <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 space-y-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-black text-slate-800 uppercase">Salvar Simulação de Cubagem</h3>
                        <button onClick={() => setShowSalvarModal(false)} className="text-slate-400 hover:text-slate-600"><FaTimes /></button>
                      </div>
                      <div className="space-y-3">
                        <label className="flex flex-col gap-1">
                          <span className="text-[10px] font-bold text-slate-500 uppercase">Título *</span>
                          <input value={simForm.titulo} onChange={e => setSimForm(f => ({ ...f, titulo: e.target.value }))}
                            placeholder="Ex: Carga Cliente X - 15/04"
                            className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 transition-all" />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-[10px] font-bold text-slate-500 uppercase">Cliente</span>
                          <input value={simForm.cliente} onChange={e => setSimForm(f => ({ ...f, cliente: e.target.value }))}
                            placeholder="Nome do cliente"
                            className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 transition-all" />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-[10px] font-bold text-slate-500 uppercase">Data da carga</span>
                          <input type="date" value={simForm.data_carga} onChange={e => setSimForm(f => ({ ...f, data_carga: e.target.value }))}
                            className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 transition-all" />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-[10px] font-bold text-slate-500 uppercase">Observação</span>
                          <textarea value={simForm.descricao} onChange={e => setSimForm(f => ({ ...f, descricao: e.target.value }))}
                            rows={2} placeholder="Instruções especiais para empilhadeirista..."
                            className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 transition-all resize-none" />
                        </label>
                      </div>
                      <div className="bg-slate-50 rounded-xl p-3 text-[10px] text-slate-500 space-y-1">
                        <div className="flex justify-between"><span>Caminhão</span><strong className="text-slate-700">{caminhaoAtual.titulo}</strong></div>
                        <div className="flex justify-between"><span>Modo</span><strong className="text-slate-700">{modoCubagem === 'manual' ? 'Manual' : 'Automático'}</strong></div>
                        <div className="flex justify-between"><span>Paletes</span><strong className="text-slate-700">{modoCubagem === 'manual' ? manualPlacements.length : filaItens.reduce((a, i) => a + (Number(i.quantidade) || 0), 0)}</strong></div>
                      </div>
                      <div className="bg-amber-50 border border-amber-200 rounded-xl p-2.5 text-[10px] text-amber-700">
                        <strong>Salvar como Carga</strong> vincula os paletes ao carregamento. Racks vinculados não aparecerão mais na listagem de paletes disponíveis.
                      </div>
                      <div className="flex justify-end gap-2 pt-2">
                        <button onClick={() => setShowSalvarModal(false)} className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-500 hover:bg-slate-50">Cancelar</button>
                        <button onClick={() => salvarSimulacao('simulacao')} disabled={!simForm.titulo.trim() || salvandoSim}
                          className="px-4 py-2 rounded-xl bg-slate-600 text-white text-xs font-bold hover:bg-slate-700 disabled:opacity-50 transition-all flex items-center gap-1.5">
                          {salvandoSim ? <><FaSync className="animate-spin w-3 h-3" /> Salvando...</> : <><FaSave className="w-3 h-3" /> Salvar Rascunho</>}
                        </button>
                        <button onClick={() => salvarSimulacao('carga')} disabled={!simForm.titulo.trim() || salvandoSim}
                          className="px-4 py-2 rounded-xl bg-amber-600 text-white text-xs font-bold hover:bg-amber-700 disabled:opacity-50 transition-all flex items-center gap-1.5">
                          {salvandoSim ? <><FaSync className="animate-spin w-3 h-3" /> Salvando...</> : <><FaTruckLoading className="w-3 h-3" /> Salvar Carga</>}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* ─── MODAL: CARREGAR SIMULAÇÃO ─── */}
                {showCarregarModal && (
                  <div className="fixed inset-0 z-[80] flex items-center justify-center">
                    <div className="absolute inset-0 bg-black/40" onClick={() => setShowCarregarModal(false)} />
                    <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 p-6 space-y-4" style={{ maxHeight: '80vh' }}>
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-black text-slate-800 uppercase">Carregar Simulação</h3>
                        <button onClick={() => setShowCarregarModal(false)} className="text-slate-400 hover:text-slate-600"><FaTimes /></button>
                      </div>
                      {carregandoSims ? (
                        <div className="flex items-center justify-center py-8 text-slate-400 text-xs"><FaSync className="animate-spin mr-2" /> Carregando...</div>
                      ) : simulacoesSalvas.length === 0 ? (
                        <div className="text-center py-8 text-slate-400 text-xs">Nenhuma simulação salva.</div>
                      ) : (
                        <div className="space-y-2 overflow-y-auto" style={{ maxHeight: '55vh' }}>
                          {simulacoesSalvas.map(sim => (
                            <button key={sim.id} onClick={() => carregarSimulacao(sim.id)}
                              className={`w-full text-left p-3 rounded-xl border transition-all hover:shadow-md ${sim.id === simulacaoCarregadaId ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/30'}`}>
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-bold text-slate-800 truncate">{sim.titulo}</p>
                                  <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-500">
                                    {sim.cliente && <span className="flex items-center gap-0.5"><FaUser className="w-2.5 h-2.5" /> {sim.cliente}</span>}
                                    <span className="flex items-center gap-0.5"><FaCalendarAlt className="w-2.5 h-2.5" /> {new Date(sim.data_carga).toLocaleDateString('pt-BR')}</span>
                                    <span className="flex items-center gap-0.5"><FaTruckLoading className="w-2.5 h-2.5" /> {sim.caminhao_titulo}</span>
                                  </div>
                                  {sim.descricao && <p className="text-[10px] text-slate-400 mt-1 truncate">{sim.descricao}</p>}
                                </div>
                                <div className="flex flex-col items-end gap-1 shrink-0">
                                  <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
                                    sim.status === 'confirmado' ? 'bg-emerald-100 text-emerald-700' :
                                    sim.status === 'expedido' ? 'bg-blue-100 text-blue-700' :
                                    sim.status === 'cancelado' ? 'bg-red-100 text-red-700' :
                                    'bg-slate-100 text-slate-500'
                                  }`}>{sim.status}</span>
                                  <span className="text-[10px] font-bold text-slate-600">{sim.total_paletes} paletes</span>
                                  <span className="text-[9px] text-slate-400">{sim.modo}</span>
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ─── VIEW: RELATÓRIO PARA IMPRESSÃO ─── */}
                {showExportView && (() => {
                  const placements = manualPlacements
                  const sorted = [...placements].sort((a, b) => (a.camada || 0) - (b.camada || 0) || a.x - b.x || a.z - b.z)
                  const numbered = sorted.map((p, i) => ({ ...p, _num: i + 1 }))
                  const folgaLin = Math.max(0, Number(folgaPerimetroCm) || 0) / 100
                  const compCam = caminhaoAtual.comprimento
                  const largCam = caminhaoAtual.largura
                  const altCam = caminhaoAtual.altura
                  const compU = Math.max(0.1, compCam - folgaLin * 2)
                  const largU = Math.max(0.1, largCam - folgaLin * 2)
                  const totalPaletes = placements.length > 0 ? placements.length : filaItens.reduce((a, i) => a + (Number(i.quantidade) || 0), 0)
                  const pesoTotal = totalPesoCargaKg ? (totalPesoCargaKg / 1000).toFixed(2) + ' t' : '—'

                  // SVG rendering helpers
                  const svgTopW = 680
                  const scaleTop = svgTopW / Math.max(compU, 0.1)
                  const svgTopH = largU * scaleTop

                  const svgSideW = 680
                  const scaleSide = svgSideW / Math.max(compU, 0.1)
                  const svgSideH = altCam * scaleSide

                  const contrastColor = (hex) => {
                    if (!hex) return '#000'
                    const c = hex.replace('#', '')
                    const r = parseInt(c.substr(0, 2), 16) || 0
                    const g = parseInt(c.substr(2, 2), 16) || 0
                    const b = parseInt(c.substr(4, 2), 16) || 0
                    return (r * 0.299 + g * 0.587 + b * 0.114) > 150 ? '#1e293b' : '#ffffff'
                  }

                  return (
                  <div className="fixed inset-0 z-[90] bg-white overflow-auto print:block" style={{ fontFamily: "'Inter', 'Segoe UI', sans-serif" }}>
                    <div className="max-w-[900px] mx-auto px-6 py-6 print:px-4 print:py-2">
                      {/* ── CABEÇALHO ── */}
                      <div className="flex items-start justify-between mb-4 print:mb-3 border-b-2 border-slate-800 pb-3">
                        <div>
                          <h1 className="text-lg font-black text-slate-900 uppercase tracking-tight">Plano de Carregamento</h1>
                          <p className="text-[11px] text-slate-500 mt-0.5">{new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}</p>
                        </div>
                        <div className="flex items-center gap-2 print:hidden">
                          <button onClick={() => { window.print() }} className="px-3 py-1.5 rounded-lg bg-slate-800 text-white text-xs font-bold hover:bg-slate-700">
                            <FaPrint className="inline mr-1" /> Imprimir
                          </button>
                          <button onClick={() => setShowExportView(false)} className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-bold text-slate-500 hover:bg-slate-50">
                            <FaTimes className="inline mr-1" /> Fechar
                          </button>
                        </div>
                      </div>

                      {/* ── INFO CARDS ── */}
                      <div className="grid grid-cols-4 gap-3 mb-5 text-[11px]">
                        <div className="border border-slate-300 rounded-lg p-2.5">
                          <p className="text-[8px] font-black text-slate-400 uppercase mb-1">Caminhão</p>
                          <p className="font-black text-slate-800 text-xs">{caminhaoAtual.titulo}</p>
                          <p className="text-slate-500 mt-0.5">{compCam}m × {largCam}m × {altCam}m</p>
                        </div>
                        <div className="border border-slate-300 rounded-lg p-2.5">
                          <p className="text-[8px] font-black text-slate-400 uppercase mb-1">Paletes</p>
                          <p className="font-black text-slate-800 text-xs">{totalPaletes} unidades</p>
                          <p className="text-slate-500 mt-0.5">Modo: {modoCubagem === 'manual' ? 'Manual' : 'Automático'}</p>
                        </div>
                        <div className="border border-slate-300 rounded-lg p-2.5">
                          <p className="text-[8px] font-black text-slate-400 uppercase mb-1">Peso Estimado</p>
                          <p className="font-black text-slate-800 text-xs">{pesoTotal}</p>
                          <p className="text-slate-500 mt-0.5">Carga total</p>
                        </div>
                        <div className="border border-slate-300 rounded-lg p-2.5">
                          <p className="text-[8px] font-black text-slate-400 uppercase mb-1">Ocupação</p>
                          <p className="font-black text-slate-800 text-xs">{simulacaoAtual?.ocupacaoPerc?.toFixed(1) || '—'}%</p>
                          <p className="text-slate-500 mt-0.5">Volume útil</p>
                        </div>
                      </div>

                      {numbered.length > 0 && (
                        <>
                          {/* ── TABELA DE ITENS ── */}
                          <h2 className="text-[11px] font-black text-slate-800 uppercase tracking-tight mb-2 flex items-center gap-1.5">
                            <span className="w-4 h-4 rounded bg-slate-800 text-white text-[8px] font-black flex items-center justify-center">#</span>
                            Sequência de Carregamento
                          </h2>
                          <table className="w-full text-[10px] border-collapse mb-5">
                            <thead>
                              <tr className="bg-slate-800 text-white">
                                <th className="border border-slate-600 px-2 py-1.5 text-center font-black w-8">Nº</th>
                                <th className="border border-slate-600 px-2 py-1.5 text-center font-bold w-6">Cor</th>
                                <th className="border border-slate-600 px-2 py-1.5 text-left font-bold">Identificação</th>
                                <th className="border border-slate-600 px-2 py-1.5 text-center font-bold">Nível</th>
                                <th className="border border-slate-600 px-2 py-1.5 text-center font-bold">Dimensões (C×L×A)</th>
                                <th className="border border-slate-600 px-2 py-1.5 text-center font-bold">Pos. X</th>
                                <th className="border border-slate-600 px-2 py-1.5 text-center font-bold">Pos. Z</th>
                              </tr>
                            </thead>
                            <tbody>
                              {numbered.map((p) => (
                                <tr key={p.id} className={p._num % 2 === 0 ? 'bg-slate-50' : 'bg-white'}>
                                  <td className="border border-slate-200 px-2 py-1 text-center font-black text-slate-800">{p._num}</td>
                                  <td className="border border-slate-200 px-2 py-1 text-center">
                                    <span className="inline-block w-3.5 h-3.5 rounded-sm border border-slate-300" style={{ background: p.cor }} />
                                  </td>
                                  <td className="border border-slate-200 px-2 py-1 font-semibold text-slate-700">{p.titulo}</td>
                                  <td className="border border-slate-200 px-2 py-1 text-center font-bold">{p.camada === 0 ? 'Chão' : `Nv.${p.camada}`}</td>
                                  <td className="border border-slate-200 px-2 py-1 text-center font-mono">{(p.w * 100).toFixed(0)}×{(p.d * 100).toFixed(0)}×{(p.alt * 100).toFixed(0)} cm</td>
                                  <td className="border border-slate-200 px-2 py-1 text-center font-mono">{p.x.toFixed(2)}m</td>
                                  <td className="border border-slate-200 px-2 py-1 text-center font-mono">{p.z.toFixed(2)}m</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>

                          {/* ── VISTA SUPERIOR (TOPO) ── */}
                          <div className="mb-5 page-break-inside-avoid">
                            <h2 className="text-[11px] font-black text-slate-800 uppercase tracking-tight mb-2">Vista Superior (Planta Baixa)</h2>
                            <p className="text-[9px] text-slate-400 mb-2">Fundo do caminhão ← → Porta traseira · Olhando de cima para baixo</p>
                            {Array.from(new Set(numbered.map(p => p.camada))).sort().map(camada => {
                              const itensCamada = numbered.filter(p => p.camada === camada)
                              return (
                                <div key={camada} className="mb-3">
                                  <p className="text-[9px] font-bold text-slate-600 mb-1">{camada === 0 ? 'Chão' : `Nível ${camada}`} — {itensCamada.length} palete(s)</p>
                                  <svg width={svgTopW} height={svgTopH + 30} viewBox={`-5 -20 ${svgTopW + 10} ${svgTopH + 30}`} className="border border-slate-300 rounded bg-white block">
                                    {/* Contorno do caminhão */}
                                    <rect x={0} y={0} width={compU * scaleTop} height={largU * scaleTop} fill="none" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="6,3" rx={3} />
                                    {/* Indicador de porta traseira */}
                                    <line x1={compU * scaleTop} y1={-4} x2={compU * scaleTop} y2={largU * scaleTop + 4} stroke="#ef4444" strokeWidth={2} />
                                    <text x={compU * scaleTop - 2} y={-8} textAnchor="end" style={{ fontSize: 7, fill: '#ef4444', fontWeight: 'bold' }}>PORTA</text>
                                    {/* Escala */}
                                    <text x={0} y={-8} textAnchor="start" style={{ fontSize: 7, fill: '#64748b' }}>FUNDO</text>
                                    <text x={compU * scaleTop / 2} y={largU * scaleTop + 14} textAnchor="middle" style={{ fontSize: 7, fill: '#64748b' }}>{compU.toFixed(1)}m</text>
                                    <text x={-3} y={largU * scaleTop / 2} textAnchor="end" style={{ fontSize: 7, fill: '#64748b', writingMode: 'tb' }}>{largU.toFixed(1)}m</text>
                                    {/* Paletes */}
                                    {itensCamada.map(p => {
                                      const rx = p.x * scaleTop, ry = p.z * scaleTop
                                      const rw = p.w * scaleTop, rh = p.d * scaleTop
                                      return (
                                        <g key={p.id}>
                                          <rect x={rx} y={ry} width={rw} height={rh} fill={p.cor} fillOpacity={0.75} stroke="#1e293b" strokeWidth={1} rx={2} />
                                          <text x={rx + rw / 2} y={ry + rh / 2 - 4} textAnchor="middle" dominantBaseline="central" style={{ fontSize: Math.min(11, rw * 0.25), fill: contrastColor(p.cor), fontWeight: '900' }}>
                                            {p._num}
                                          </text>
                                          <text x={rx + rw / 2} y={ry + rh / 2 + 6} textAnchor="middle" dominantBaseline="central" style={{ fontSize: Math.min(7, rw * 0.14), fill: contrastColor(p.cor), fontWeight: '600' }}>
                                            {p.titulo.length > 12 ? p.titulo.slice(0, 12) + '…' : p.titulo}
                                          </text>
                                        </g>
                                      )
                                    })}
                                  </svg>
                                </div>
                              )
                            })}
                          </div>

                          {/* ── VISTA LATERAL DIREITA ── */}
                          <div className="mb-5 page-break-inside-avoid" style={{ pageBreakBefore: 'auto' }}>
                            <h2 className="text-[11px] font-black text-slate-800 uppercase tracking-tight mb-2">Vista Lateral Direita</h2>
                            <p className="text-[9px] text-slate-400 mb-2">Fundo do caminhão ← → Porta traseira · Olhando pelo lado direito (Z = 0)</p>
                            <svg width={svgSideW} height={svgSideH + 30} viewBox={`-5 -20 ${svgSideW + 10} ${svgSideH + 30}`} className="border border-slate-300 rounded bg-white block">
                              {/* Contorno do caminhão */}
                              <rect x={0} y={0} width={compU * scaleSide} height={altCam * scaleSide} fill="none" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="6,3" rx={3} />
                              {/* Chão */}
                              <line x1={0} y1={altCam * scaleSide} x2={compU * scaleSide} y2={altCam * scaleSide} stroke="#475569" strokeWidth={2} />
                              {/* Porta traseira */}
                              <line x1={compU * scaleSide} y1={-4} x2={compU * scaleSide} y2={altCam * scaleSide + 4} stroke="#ef4444" strokeWidth={2} />
                              <text x={compU * scaleSide - 2} y={-8} textAnchor="end" style={{ fontSize: 7, fill: '#ef4444', fontWeight: 'bold' }}>PORTA</text>
                              <text x={0} y={-8} textAnchor="start" style={{ fontSize: 7, fill: '#64748b' }}>FUNDO</text>
                              {/* Escala */}
                              <text x={compU * scaleSide / 2} y={altCam * scaleSide + 14} textAnchor="middle" style={{ fontSize: 7, fill: '#64748b' }}>{compU.toFixed(1)}m</text>
                              {/* Paletes — projeção lateral: X = posição ao longo do caminhão, Y = altura (invertida pois SVG Y cresce para baixo) */}
                              {numbered.map(p => {
                                const rx = p.x * scaleSide
                                const rw = p.w * scaleSide
                                const rh = p.alt * scaleSide
                                const ry = (altCam - (p.yCalc || 0) - p.alt) * scaleSide
                                return (
                                  <g key={p.id}>
                                    <rect x={rx} y={ry} width={rw} height={rh} fill={p.cor} fillOpacity={0.8} stroke="#1e293b" strokeWidth={1} rx={1} />
                                    <text x={rx + rw / 2} y={ry + rh / 2 - 3} textAnchor="middle" dominantBaseline="central" style={{ fontSize: Math.min(12, rw * 0.3, rh * 0.4), fill: contrastColor(p.cor), fontWeight: '900' }}>
                                      {p._num}
                                    </text>
                                    <text x={rx + rw / 2} y={ry + rh / 2 + 6} textAnchor="middle" dominantBaseline="central" style={{ fontSize: Math.min(7, rw * 0.15, rh * 0.2), fill: contrastColor(p.cor), fontWeight: '600' }}>
                                      {p.titulo.length > 10 ? p.titulo.slice(0, 10) + '…' : p.titulo}
                                    </text>
                                  </g>
                                )
                              })}
                              {/* Escala vertical */}
                              <text x={compU * scaleSide + 8} y={altCam * scaleSide / 2} textAnchor="start" style={{ fontSize: 7, fill: '#64748b' }}>{altCam.toFixed(1)}m</text>
                            </svg>
                          </div>

                          {/* ── VISTA LATERAL ESQUERDA ── */}
                          <div className="mb-5 page-break-inside-avoid">
                            <h2 className="text-[11px] font-black text-slate-800 uppercase tracking-tight mb-2">Vista Lateral Esquerda</h2>
                            <p className="text-[9px] text-slate-400 mb-2">Porta traseira ← → Fundo do caminhão · Olhando pelo lado esquerdo (Z = máx) · Espelhado</p>
                            <svg width={svgSideW} height={svgSideH + 30} viewBox={`-5 -20 ${svgSideW + 10} ${svgSideH + 30}`} className="border border-slate-300 rounded bg-white block">
                              {/* Contorno do caminhão */}
                              <rect x={0} y={0} width={compU * scaleSide} height={altCam * scaleSide} fill="none" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="6,3" rx={3} />
                              {/* Chão */}
                              <line x1={0} y1={altCam * scaleSide} x2={compU * scaleSide} y2={altCam * scaleSide} stroke="#475569" strokeWidth={2} />
                              {/* Porta traseira (agora à esquerda) */}
                              <line x1={0} y1={-4} x2={0} y2={altCam * scaleSide + 4} stroke="#ef4444" strokeWidth={2} />
                              <text x={2} y={-8} textAnchor="start" style={{ fontSize: 7, fill: '#ef4444', fontWeight: 'bold' }}>PORTA</text>
                              <text x={compU * scaleSide} y={-8} textAnchor="end" style={{ fontSize: 7, fill: '#64748b' }}>FUNDO</text>
                              {/* Escala */}
                              <text x={compU * scaleSide / 2} y={altCam * scaleSide + 14} textAnchor="middle" style={{ fontSize: 7, fill: '#64748b' }}>{compU.toFixed(1)}m</text>
                              {/* Paletes espelhados no eixo X */}
                              {numbered.map(p => {
                                const rxMirror = (compU - p.x - p.w) * scaleSide
                                const rw = p.w * scaleSide
                                const rh = p.alt * scaleSide
                                const ry = (altCam - (p.yCalc || 0) - p.alt) * scaleSide
                                return (
                                  <g key={p.id}>
                                    <rect x={rxMirror} y={ry} width={rw} height={rh} fill={p.cor} fillOpacity={0.8} stroke="#1e293b" strokeWidth={1} rx={1} />
                                    <text x={rxMirror + rw / 2} y={ry + rh / 2 - 3} textAnchor="middle" dominantBaseline="central" style={{ fontSize: Math.min(12, rw * 0.3, rh * 0.4), fill: contrastColor(p.cor), fontWeight: '900' }}>
                                      {p._num}
                                    </text>
                                    <text x={rxMirror + rw / 2} y={ry + rh / 2 + 6} textAnchor="middle" dominantBaseline="central" style={{ fontSize: Math.min(7, rw * 0.15, rh * 0.2), fill: contrastColor(p.cor), fontWeight: '600' }}>
                                      {p.titulo.length > 10 ? p.titulo.slice(0, 10) + '…' : p.titulo}
                                    </text>
                                  </g>
                                )
                              })}
                              {/* Escala vertical */}
                              <text x={compU * scaleSide + 8} y={altCam * scaleSide / 2} textAnchor="start" style={{ fontSize: 7, fill: '#64748b' }}>{altCam.toFixed(1)}m</text>
                            </svg>
                          </div>

                          {/* ── VISTA FRONTAL (PELA PORTA) ── */}
                          <div className="mb-5 page-break-inside-avoid">
                            <h2 className="text-[11px] font-black text-slate-800 uppercase tracking-tight mb-2">Vista Frontal (Pela Porta Traseira)</h2>
                            <p className="text-[9px] text-slate-400 mb-2">Esquerda ← → Direita · Olhando pela porta traseira para dentro do caminhão</p>
                            {(() => {
                              const svgFrontW = 400
                              const scaleFront = svgFrontW / Math.max(largU, 0.1)
                              const svgFrontH = altCam * scaleFront
                              return (
                                <svg width={svgFrontW} height={svgFrontH + 30} viewBox={`-5 -20 ${svgFrontW + 10} ${svgFrontH + 30}`} className="border border-slate-300 rounded bg-white block">
                                  {/* Contorno do caminhão */}
                                  <rect x={0} y={0} width={largU * scaleFront} height={altCam * scaleFront} fill="none" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="6,3" rx={3} />
                                  {/* Chão */}
                                  <line x1={0} y1={altCam * scaleFront} x2={largU * scaleFront} y2={altCam * scaleFront} stroke="#475569" strokeWidth={2} />
                                  <text x={0} y={-8} textAnchor="start" style={{ fontSize: 7, fill: '#64748b' }}>ESQ</text>
                                  <text x={largU * scaleFront} y={-8} textAnchor="end" style={{ fontSize: 7, fill: '#64748b' }}>DIR</text>
                                  {/* Escala */}
                                  <text x={largU * scaleFront / 2} y={altCam * scaleFront + 14} textAnchor="middle" style={{ fontSize: 7, fill: '#64748b' }}>{largU.toFixed(1)}m</text>
                                  {/* Paletes — projeção frontal: Z = posição lateral, Y = altura */}
                                  {numbered.map(p => {
                                    const rx = p.z * scaleFront
                                    const rw = p.d * scaleFront
                                    const rh = p.alt * scaleFront
                                    const ry = (altCam - (p.yCalc || 0) - p.alt) * scaleFront
                                    return (
                                      <g key={p.id}>
                                        <rect x={rx} y={ry} width={rw} height={rh} fill={p.cor} fillOpacity={0.75} stroke="#1e293b" strokeWidth={1} rx={1} />
                                        <text x={rx + rw / 2} y={ry + rh / 2} textAnchor="middle" dominantBaseline="central" style={{ fontSize: Math.min(11, rw * 0.3, rh * 0.35), fill: contrastColor(p.cor), fontWeight: '900' }}>
                                          {p._num}
                                        </text>
                                      </g>
                                    )
                                  })}
                                  <text x={largU * scaleFront + 8} y={altCam * scaleFront / 2} textAnchor="start" style={{ fontSize: 7, fill: '#64748b' }}>{altCam.toFixed(1)}m</text>
                                </svg>
                              )
                            })()}
                          </div>
                        </>
                      )}

                      {/* ── RODAPÉ ── */}
                      <div className="border-t-2 border-slate-800 pt-3 mt-4 text-[9px] text-slate-400 flex justify-between">
                        <span>Gerado em {new Date().toLocaleString('pt-BR')}</span>
                        <span className="font-bold text-slate-600">Expedição · Plano de Cubagem</span>
                      </div>
                    </div>
                  </div>
                  )
                })()}

                <div className="grid lg:grid-cols-2 gap-4">
                  <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center">
                        <FaSync className="w-4 h-4" />
                      </div>
                      <p className="text-sm font-black text-slate-800 uppercase tracking-tight">Parâmetros da simulação</p>
                    </div>
                    <div className="grid grid-cols-2 gap-4 text-xs">
                      <label className="flex flex-col gap-1.5">
                        <span className="text-[10px] text-slate-400 font-black uppercase">Folga lateral (cm)</span>
                        <input type="number" value={folgaPerimetroCm} onChange={(e) => setFolgaPerimetroCm(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2 bg-slate-50 focus:bg-white focus:border-amber-500 transition-all font-bold" />
                      </label>
                      <label className="flex flex-col gap-1.5">
                        <span className="text-[10px] text-slate-400 font-black uppercase">Folga de altura (cm)</span>
                        <input type="number" value={folgaAlturaCm} onChange={(e) => setFolgaAlturaCm(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2 bg-slate-50 focus:bg-white focus:border-amber-500 transition-all font-bold" />
                      </label>
                      <label className="col-span-2 flex items-center gap-3 p-3 bg-slate-50 border border-slate-100 rounded-xl cursor-pointer hover:bg-slate-100 transition-colors group">
                        <input type="checkbox" checked={considerarAltura} onChange={(e) => setConsiderarAltura(e.target.checked)} className="w-5 h-5 rounded-lg border-slate-300 text-amber-500 focus:ring-amber-500 cursor-pointer" />
                        <span className="text-[11px] text-slate-600 font-bold uppercase tracking-tight group-hover:text-slate-900 transition-colors">Considerar empilhamento vertical</span>
                      </label>
                    </div>
                  </section>

                  <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center">
                        <FaClipboardList className="w-4 h-4" />
                      </div>
                      <p className="text-sm font-black text-slate-800 uppercase tracking-tight">Detalhes do Encaixe</p>
                    </div>
                    {simulacaoAtual ? (
                      <div className="grid grid-cols-2 gap-3">
                        <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                          <p className="text-[9px] text-slate-400 font-black uppercase mb-1 text-center">Capacidade/Piso</p>
                          <p className="text-xl font-black text-slate-800 text-center">{simulacaoAtual.capacidadePorPiso || 0}</p>
                        </div>
                        <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                          <p className="text-[9px] text-slate-400 font-black uppercase mb-1 text-center">Camadas Vert.</p>
                          <p className="text-xl font-black text-slate-800 text-center">{simulacaoAtual.camadasVerticais}</p>
                        </div>
                        <div className="col-span-2 p-3 bg-emerald-50 rounded-xl border border-emerald-100">
                          <div className="flex justify-between items-center text-[10px] font-black text-emerald-700 uppercase tracking-tight">
                            <span>Ocupação do Baú</span>
                            <span>{Math.round((simulacaoAtual.ocupacaoVolume || 0) * 100)}%</span>
                          </div>
                          <div className="h-2 rounded-full bg-emerald-200 mt-2 overflow-hidden">
                            <div className="h-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.3)]" style={{ width: `${Math.min(100, Math.round((simulacaoAtual.ocupacaoVolume || 0) * 100))}%` }} />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="h-full flex items-center justify-center text-center">
                        <p className="text-xs text-slate-400 font-medium italic">Selecione itens para ver os resultados.</p>
                      </div>
                    )}
                  </section>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Modal: Salvar Novo Modelo de Amarrado */}
        {showSalvarModeloModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-white rounded-lg shadow-2xl p-6 max-w-md w-full mx-4">
              <h3 className="text-lg font-bold text-slate-800 mb-4">Salvar Modelo de Amarrado</h3>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1 uppercase">Ferramenta</label>
                    <div className="px-3 py-2 border border-slate-200 rounded-lg bg-slate-50 text-slate-700 font-semibold text-sm">
                      {ferramenta || '-'}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1 uppercase">Comprimento (mm)</label>
                    <div className="px-3 py-2 border border-slate-200 rounded-lg bg-slate-50 text-slate-700 font-semibold text-sm">
                      {comprimento || '-'}
                    </div>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1">Nome do Modelo *</label>
                  <input
                    type="text"
                    value={nomeNovoModelo}
                    onChange={(e) => setNomeNovoModelo(e.target.value)}
                    placeholder="Ex: Amarrado Padrão"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1">Descrição (opcional)</label>
                  <textarea
                    value={descricaoNovoModelo}
                    onChange={(e) => setDescricaoNovoModelo(e.target.value)}
                    placeholder="Ex: Perfil circular 19mm, 18 peças, 5 por linha"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
                    rows="3"
                  />
                </div>
              </div>
              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => setShowSalvarModeloModal(false)}
                  className="flex-1 px-4 py-2 border border-slate-300 text-slate-700 font-semibold rounded-lg hover:bg-slate-50 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={salvarNovoModelo}
                  disabled={salvandoModelo}
                  className={`flex-1 px-4 py-2 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 ${
                    salvandoModelo 
                      ? 'bg-gray-400 cursor-not-allowed' 
                      : 'bg-green-600 hover:bg-green-700'
                  }`}
                >
                  {salvandoModelo ? (
                    <>
                      <div className="animate-spin">⏳</div>
                      Salvando...
                    </>
                  ) : (
                    <>
                      <FaSave size={16} />
                      Salvar
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal: Carregar Modelo de Amarrado */}
        {showCarregarModeloModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-white rounded-lg shadow-2xl p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
              <h3 className="text-lg font-bold text-slate-800 mb-4">Carregar Modelo de Amarrado</h3>
              
              {carregandoModelos ? (
                <div className="flex items-center justify-center py-8 text-slate-500">
                  <div className="animate-spin mr-2">⏳</div>
                  Carregando modelos...
                </div>
              ) : modelosAmarrado.length === 0 ? (
                <div className="py-8 text-center text-slate-500">
                  <p>Nenhum modelo salvo para esta ferramenta.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {modelosAmarrado.map((modelo) => (
                    <div
                      key={modelo.id}
                      className="flex items-center justify-between p-3 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                    >
                      <div className="flex-1">
                        <p className="font-semibold text-slate-800">{modelo.nome}</p>
                        <p className="text-xs text-slate-500">
                          {modelo.tipo === 'circular' ? '⭕' : '▭'} {modelo.quantidade} peças · {modelo.largura}mm · {modelo.comprimento}mm
                        </p>
                        {modelo.descricao && (
                          <p className="text-xs text-slate-600 mt-1">{modelo.descricao}</p>
                        )}
                      </div>
                      <div className="flex gap-2 ml-4">
                        <button
                          onClick={() => carregarModeloSelecionado(modelo.id)}
                          className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded transition-colors"
                        >
                          Carregar
                        </button>
                        <button
                          onClick={() => deletarModelo(modelo.id)}
                          className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded transition-colors"
                        >
                          <FaTrash size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => setShowCarregarModeloModal(false)}
                  className="flex-1 px-4 py-2 border border-slate-300 text-slate-700 font-semibold rounded-lg hover:bg-slate-50 transition-colors"
                >
                  Fechar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Toast Notification */}
        {msg && (
          <div className="fixed bottom-6 right-6 z-50 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <div className={`px-6 py-3 rounded-lg shadow-xl text-white font-semibold flex items-center gap-3 ${
              msg.includes('atualizado') 
                ? 'bg-blue-600' 
                : msg.includes('salvo') 
                ? 'bg-green-600' 
                : msg.includes('carregado')
                ? 'bg-cyan-600'
                : msg.includes('deletado')
                ? 'bg-orange-600'
                : 'bg-slate-700'
            }`}>
              <span className="text-lg">
                {msg.includes('atualizado') && '✏️'}
                {msg.includes('Novo') && '✅'}
                {msg.includes('carregado') && '📂'}
                {msg.includes('deletado') && '🗑️'}
                {msg.includes('Erro') && '❌'}
              </span>
              <span>{msg}</span>
            </div>
          </div>
        )}
    </div>
  )
}

// ─── WRAPPER MODAL (mantido para compatibilidade com ApontamentosUsinagem) ────
const ModalPalete3D = ({ open, onClose, ferramenta, comprimento, isAdmin = false }) => {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black bg-opacity-50" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-[1400px] mx-2 sm:mx-4 overflow-hidden flex flex-col" style={{ maxHeight: 'min(92vh, calc(100vh - 32px))', minHeight: 0 }}>
        {/* Header do modal */}
        <div className="flex items-center justify-between bg-gradient-to-r from-amber-600 to-orange-500 px-5 py-3 flex-shrink-0">
          <div className="flex items-center gap-2 text-white">
            <FaCubes className="text-xl" />
            <span className="font-bold text-base">Montagem do Palete</span>
            {ferramenta && (
              <span className="ml-2 bg-white/20 rounded px-2 py-0.5 text-sm font-mono font-bold">{ferramenta}</span>
            )}
          </div>
          <button onClick={onClose} className="text-white hover:text-orange-200 transition-colors"><FaTimes /></button>
        </div>
        <PaleteConteudo ferramenta={ferramenta} comprimento={comprimento} isAdmin={isAdmin} onClose={onClose} />
      </div>
    </div>
  )
}

export default ModalPalete3D
