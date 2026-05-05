/**
 * Otimizador de Kits para Romaneios
 * Calcula as melhores combinações de paletes para formar kits completos
 */

/**
 * Calcula quantos kits completos podem ser formados com os paletes disponíveis
 * @param {Array} paletes - Array de paletes com {produto, comprimento, quantidade}
 * @param {Array} kitComponentes - Array de componentes do kit com {produto, comprimento, quantidade_por_kit, origem}
 * @param {Object} quantidadesExternas - Mapa de produto|comprimento → quantidade disponível para itens externos
 * @returns {Object} { quantidadeKits, paletesSelecionados, componentesExternos, sobras }
 */
export function calcularKitsCompletos(paletes, kitComponentes, quantidadesExternas = {}) {
  if (!paletes || !kitComponentes || kitComponentes.length === 0) {
    return { quantidadeKits: 0, paletesSelecionados: [], componentesExternos: [], sobras: [] }
  }

  // Normalizar dados dos paletes - preservar informações de racks
  const paletesDisponiveis = paletes.map(p => ({
    ...p,
    produto: String(p.produto || '').trim().toUpperCase(),
    ferramenta: String(p.ferramenta || '').trim().toUpperCase(),
    comprimento: String(p.comprimento || '').trim(),
    quantidadeDisponivel: Number(p.quantidade || p.qtd_pc || 0),
    racks: p.racks || [], // Preservar array de racks
  }))

  // Normalizar dados dos componentes do kit
  const componentes = kitComponentes.map(c => ({
    ...c,
    produto: String(c.produto).trim().toUpperCase(),
    comprimento: String(c.comprimento || '').trim(),
    quantidadeNecessaria: Number(c.quantidade_por_kit || 1),
    origem: c.origem || 'usinagem',
  }))

  // Separar componentes por origem
  const componentesUsinagem = componentes.filter(c => c.origem !== 'externo')
  const componentesExternos = componentes.filter(c => c.origem === 'externo')

  // Agrupar paletes por produto+comprimento
  const paletesAgrupados = {}
  paletesDisponiveis.forEach(p => {
    const chave = `${p.produto}|${p.comprimento}`
    if (!paletesAgrupados[chave]) {
      paletesAgrupados[chave] = []
    }
    paletesAgrupados[chave].push(p)
  })

  // Calcular quantidade máxima de kits que podem ser formados
  let quantidadeMaximaKits = Infinity
  const paletesSelecionados = []

  // Processar componentes de usinagem (buscar nos paletes)
  for (const componente of componentesUsinagem) {
    // Usar produto completo para buscar nos paletes agrupados
    const chave = `${componente.produto}|${componente.comprimento}`
    const paletesDoComponente = paletesAgrupados[chave] || []
    
    // Somar quantidade disponível de todos os paletes deste componente
    const quantidadeDisponivel = paletesDoComponente.reduce((sum, p) => sum + p.quantidadeDisponivel, 0)
    
    // Calcular quantos kits podem ser feitos com este componente
    const kitsComEsteComponente = Math.floor(quantidadeDisponivel / componente.quantidadeNecessaria)
    
    quantidadeMaximaKits = Math.min(quantidadeMaximaKits, kitsComEsteComponente)

    // Guardar paletes selecionados com informações de racks
    if (paletesDoComponente.length > 0) {
      // Expandir paletes para incluir informações individuais de racks
      const paletesComRacks = []
      for (const palete of paletesDoComponente) {
        if (palete.racks && palete.racks.length > 0) {
          // Se tem array de paletes, expandir cada um
          for (const paletItem of palete.racks) {
            paletesComRacks.push({
              ...palete,
              palete: paletItem.palete,
              rack: paletItem.palete,
              quantidadeDisponivel: paletItem.quantidade,
              apontamentoId: paletItem.apontamentoId,
              produtoOriginal: paletItem.produtoOriginal,
            })
          }
        } else {
          paletesComRacks.push(palete)
        }
      }

      paletesSelecionados.push({
        componente: componente.produto,
        comprimento: componente.comprimento,
        quantidadeNecessaria: componente.quantidadeNecessaria,
        origem: 'usinagem',
        paletes: paletesComRacks,
        quantidadeDisponivel,
      })
    }
  }

  // Processar componentes externos (usar quantidades informadas manualmente)
  const componentesExternosInfo = []
  for (const componente of componentesExternos) {
    const chave = `${componente.produto}|${componente.comprimento}`
    const qtdDisponivel = Number(quantidadesExternas[chave] || 0)
    const kitsComEsteComponente = qtdDisponivel > 0
      ? Math.floor(qtdDisponivel / componente.quantidadeNecessaria)
      : Infinity // Se não informou, não limita (assume disponível)

    if (qtdDisponivel > 0) {
      quantidadeMaximaKits = Math.min(quantidadeMaximaKits, kitsComEsteComponente)
    }

    componentesExternosInfo.push({
      componente: componente.produto,
      comprimento: componente.comprimento,
      quantidadeNecessaria: componente.quantidadeNecessaria,
      origem: 'externo',
      quantidadeDisponivel: qtdDisponivel || 'Não informado',
    })
  }

  // Se não tem componentes de usinagem e nenhum externo com quantidade, retornar vazio
  if (quantidadeMaximaKits === Infinity || quantidadeMaximaKits <= 0) {
    return { quantidadeKits: 0, paletesSelecionados: [], componentesExternos: componentesExternosInfo, sobras: [] }
  }

  // Calcular quais paletes serão usados e quais sobram
  const paletesSelecionadosFinais = []
  const sobras = []

  for (const item of paletesSelecionados) {
    let quantidadeNecessariaTotal = item.quantidadeNecessaria * quantidadeMaximaKits
    const paletesUsados = []

    for (const palete of item.paletes) {
      if (quantidadeNecessariaTotal <= 0) {
        sobras.push(palete)
        continue
      }

      const quantidadeDoParlete = Math.min(palete.quantidadeDisponivel, quantidadeNecessariaTotal)
      
      paletesUsados.push({
        ...palete,
        quantidadeUsada: quantidadeDoParlete,
        quantidadeSobra: palete.quantidadeDisponivel - quantidadeDoParlete,
      })

      quantidadeNecessariaTotal -= quantidadeDoParlete
    }

    // Manter a estrutura original com o array de paletes
    paletesSelecionadosFinais.push({
      componente: item.componente,
      comprimento: item.comprimento,
      quantidadeNecessaria: item.quantidadeNecessaria,
      quantidadeDisponivel: item.quantidadeDisponivel,
      origem: 'usinagem',
      paletes: paletesUsados,
    })
  }

  return {
    quantidadeKits: quantidadeMaximaKits,
    paletesSelecionados: paletesSelecionadosFinais,
    componentesExternos: componentesExternosInfo,
    sobras,
  }
}

/**
 * Encontra a melhor combinação de kits para preencher um caminhão
 * @param {Array} paletes - Array de paletes disponíveis
 * @param {Array} kits - Array de kits cadastrados com seus componentes
 * @param {Object} caminhao - {capacidadeVolume, capacidadePeso, cliente}
 * @returns {Array} Array de kits otimizados para a carga
 */
export function otimizarCargaPorKits(paletes, kits, caminhao = {}) {
  if (!paletes || !kits || paletes.length === 0 || kits.length === 0) {
    return []
  }

  const resultado = []

  // Para cada kit, calcular quantos podem ser formados
  for (const kit of kits) {
    const calculo = calcularKitsCompletos(paletes, kit.componentes || [])
    
    if (calculo.quantidadeKits > 0) {
      resultado.push({
        kitId: kit.id,
        kitCodigo: kit.codigo,
        kitNome: kit.nome,
        cliente: kit.cliente,
        quantidadeKits: calculo.quantidadeKits,
        paletesSelecionados: calculo.paletesSelecionados,
        sobras: calculo.sobras,
      })
    }
  }

  // Ordenar por quantidade de kits (maior primeiro) para otimizar carga
  return resultado.sort((a, b) => b.quantidadeKits - a.quantidadeKits)
}

/**
 * Simula diferentes combinações de kits para preencher a carga
 * @param {Array} paletesDisponiveis - Paletes disponíveis
 * @param {Array} kitsDisponiveis - Kits cadastrados
 * @param {Object} restricoes - {clientesFiltro, capacidadeMinima}
 * @returns {Array} Simulações com diferentes combinações
 */
export function simularCombinacoes(paletesDisponiveis, kitsDisponiveis, restricoes = {}) {
  const simulacoes = []
  const { clientesFiltro = [], capacidadeMinima = 0 } = restricoes

  // Filtrar kits por cliente se especificado
  let kitsFiltrados = kitsDisponiveis
  if (clientesFiltro.length > 0) {
    kitsFiltrados = kitsDisponiveis.filter(k => clientesFiltro.includes(k.cliente))
  }

  // Gerar simulações para cada combinação de kits
  for (let i = 0; i < kitsFiltrados.length; i++) {
    for (let j = i; j < kitsFiltrados.length; j++) {
      const kit1 = kitsFiltrados[i]
      const kit2 = kitsFiltrados[j]

      const calculo1 = calcularKitsCompletos(paletesDisponiveis, kit1.componentes || [])
      const calculo2 = i !== j ? calcularKitsCompletos(paletesDisponiveis, kit2.componentes || []) : calculo1

      if (calculo1.quantidadeKits > 0 || calculo2.quantidadeKits > 0) {
        simulacoes.push({
          kits: i === j ? [kit1] : [kit1, kit2],
          quantidadeKits: calculo1.quantidadeKits + (i !== j ? calculo2.quantidadeKits : 0),
          detalhes: [calculo1, i !== j ? calculo2 : null].filter(Boolean),
        })
      }
    }
  }

  return simulacoes.sort((a, b) => b.quantidadeKits - a.quantidadeKits)
}
