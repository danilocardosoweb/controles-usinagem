export const calcularTurno = (dataHora) => {
  if (!dataHora) return ''
  try {
    const date = new Date(dataHora)
    const horas = date.getHours()
    const minutos = date.getMinutes()
    const totalMinutos = horas * 60 + minutos
    
    // TB: 06:30 (390 min) às 16:10 (970 min)
    // TC: 16:11 (971 min) às 01:30 (90 min do dia seguinte)
    const tb_inicio = 6 * 60 + 30  // 390
    const tb_fim = 16 * 60 + 10    // 970
    const tc_inicio = 16 * 60 + 11 // 971
    
    if (totalMinutos >= tb_inicio && totalMinutos <= tb_fim) {
      return 'TB'
    } else if (totalMinutos >= tc_inicio || totalMinutos <= 1 * 60 + 30) {
      return 'TC'
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * Dado um produto (item) e os arrays de kits+componentes,
 * retorna o nome descritivo do primeiro kit que contém esse produto.
 */
export const resolverNomeKit = (produto, kits = [], componentes = []) => {
  if (!produto || !kits.length) return ''
  const prodUpper = String(produto).toUpperCase().trim()
  for (const kit of kits) {
    const compsDoKit = componentes.filter(c => String(c.kit_id) === String(kit.id))
    if (compsDoKit.some(c => String(c.produto || '').toUpperCase().trim() === prodUpper)) {
      return kit.nome || ''
    }
  }
  return ''
}

export const buildFormularioIdentificacaoHtml = ({
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
}) => {
  const loteMPVal = loteMP || ''
  const dataVal = dataProducao || ''
  const turnoVal = turno || calcularTurno(dataHoraProducao || dataProducao)

  return `<!DOCTYPE html>
  <html><head><meta charset="utf-8" />
  <style>
    @page { 
      size: A4 landscape; 
      margin: 8mm; /* Ajustado para dar bom respiro mas sem forçar 2 páginas */
    }
    @media print {
      @page {
        size: landscape;
        margin: 8mm;
      }
      body {
        margin: 0;
        padding: 0; 
      }
    }
    body { 
      font-family: 'Segoe UI', Arial, sans-serif; 
      color: #000; 
      margin: 0;
      padding: 0; 
      background: #fff;
      -webkit-print-color-adjust: exact; 
      print-color-adjust: exact; 
    }
    .container {
      max-width: 100%;
      height: 175mm; /* Altura máxima para não passar de 1 página, ocupando melhor o espaço */
      margin: 0 auto;
      background: #fff;
      border: 2px solid #000;
      padding: 5mm 10mm; /* Aumentar padding interno */
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      justify-content: space-between; /* Distribui o espaço uniformemente */
    }
    .header { 
      text-align: center; 
      border-bottom: 2px solid #000;
      padding-bottom: 5mm; 
    }
    .titulo { 
      font-size: 18pt; /* Fonte maior */
      font-weight: 800; 
      text-transform: uppercase;
      letter-spacing: 0.5pt;
      margin: 0;
    }
    .sub { 
      margin-top: 2mm; 
      font-size: 10pt; 
      font-weight: 600; 
      color: #333;
      display: flex;
      gap: 6mm;
      justify-content: center;
      flex-wrap: nowrap;
    }
    .sub-item {
      white-space: nowrap;
    }
    .form-grid { 
      display: grid;
      grid-template-columns: 20% 80%; /* Ajuste para dar mais espaço ao label */
      gap: 4mm 0; /* Maior espaçamento vertical */
      align-items: center;
    }
    .form-grid.dupla-coluna {
      grid-template-columns: 20% 30% 20% 30%;
      gap: 0;
    }
    .form-grid.dupla-coluna .form-row {
      display: contents;
    }
    .form-row {
      display: contents;
    }
    .form-row.dupla {
      display: grid;
      grid-column: 1 / -1;
      grid-template-columns: 20% 35% 15% 30%;
      gap: 0;
      align-items: center;
      margin: 2mm 0; /* Mais respiro ao redor desta linha */
    }
    .label { 
      font-weight: 700; 
      font-size: 11pt; /* Maior */
      text-transform: uppercase;
      letter-spacing: 0.5pt;
      color: #000;
      padding-right: 4mm;
      text-align: right; /* Alinha labels à direita para ficar mais limpo */
    }
    .valor { 
      border-bottom: 1px solid #000; 
      font-size: 14pt; /* Maior */
      font-weight: 600;
      padding: 1mm 2mm; 
      text-align: center;
      background: #f9f9f9;
    }
    .valor:empty::after {
      content: '';
      display: inline-block;
      width: 100%;
      height: 7mm; 
    }
    .footer {
      font-size: 10pt;
      color: #666;
      text-align: right;
      margin-top: 3mm;
      padding-top: 2mm;
      border-top: 1px solid #ccc;
    }
  </style>
  </head><body>
    <div class="container">
      <div class="header">
        <div class="titulo">Formulário de Identificação do Material Cortado</div>
        <div class="sub">
          <span class="sub-item">Lote: ${lote || ''}</span>
          ${loteMPVal ? `<span class="sub-item">| Lote MP: ${loteMPVal}</span>` : ''}
        </div>
      </div>
      
      <div class="form-grid">
        <div class="form-row">
          <div class="label">Cliente:</div>
          <div class="valor">${cliente || ''}</div>
        </div>
        
        <div class="form-row">
          <div class="label">Item:</div>
          <div class="valor">${item || ''}</div>
        </div>
        
        <div class="form-row">
          <div class="label">Código Cliente:</div>
          <div class="valor" style="display:flex;align-items:center;justify-content:center;gap:10px;">${codigoCliente || ''}${nomeKit ? `<span style="font-size:13pt;font-weight:800;color:#1a3a6b;letter-spacing:0.3pt;border-left:3px solid #1a3a6b;padding-left:10px;"> ${nomeKit}</span>` : ''}</div>
        </div>
        
        <div class="form-row">
          <div class="label">Medida:</div>
          <div class="valor">${medida || ''}</div>
        </div>
        
        <div class="form-row">
          <div class="label">Pedido Tecno:</div>
          <div class="valor">${pedidoTecno || ''}</div>
        </div>
      </div>
      
      <div class="form-row dupla">
        <div class="label">Qtde:</div>
        <div class="valor" style="text-align: center;">${qtde || ''}</div>
        <div class="label" style="text-align: right; padding-right: 4mm;">Palet:</div>
        <div class="valor" style="text-align: center;">${pallet || ''}</div>
      </div>
      
      <div class="form-grid dupla-coluna">
        <div class="form-row">
          <div class="label">Pedido Cli:</div>
          <div class="valor">${pedidoCli || ''}</div>
        </div>
        
        <div class="form-row">
          <div class="label">Turno:</div>
          <div class="valor">${turnoVal || ''}</div>
        </div>
        
        <div class="form-row">
          <div class="label">Dureza:</div>
          <div class="valor">${dureza || ''}</div>
        </div>
        
        <div class="form-row">
          <div class="label">Data Prod:</div>
          <div class="valor">${dataVal || ''}</div>
        </div>
      </div>
    </div>
  </body></html>`
}
