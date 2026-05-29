/*
 * dashboard_mayo_v41.js
 * Módulo de integración de datos de Mayo (Ciclo 1 y Ciclo 2)
 * desde Google Sheets publicados como CSV.
 *
 * INSTRUCCIONES DE USO:
 * Añadir este <script> en el HTML justo antes del bloque <script> principal,
 * después de todos los dashboard_data_*.js:
 *
 *   <script src="dashboard_mayo_v41.js?v=41"></script>
 *
 * El módulo inyecta automáticamente las filas de Mayo en PERF_BASE, PERF_COMP,
 * PERF_IND, READ y COV antes de que init() renderice el dashboard.
 */

(function () {
  'use strict';

  /* ── URLs de los CSV publicados ───────────────────────────────────────── */
  const URL_CICLO1 = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSgWQ4GaAwm8gCAkOUU47IM_M0EneHHDg774yY1QfmuZeXyV0VXFJfeO752SP0yhDfVNCvZILpLpHTc/pub?output=csv';
  const URL_CICLO2 = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSE7lqSqf1Ugps--yciQGl9iXDwcuRXq7DmPolyClxNqtILprSaixafW7j_gFOq_tmePtoY-hpUj6XH/pub?output=csv';

  /* ── Mapas de nomenclatura ────────────────────────────────────────────── */
  const AREA_MAP = {
    'LE': 'Lengua Española',
    'LT': 'Lengua Española',   // lectura (Ciclo 1 usa LT para los niveles de lectura)
    'MA': 'Matemática',
    'CS': 'Ciencias Sociales',
    'CN': 'Ciencias de la Naturaleza'
  };

  // Niveles de lectura: N1..N5 → nombre canónico del dashboard
  const READ_LEVEL_MAP = {
    'N1': 'Lector de imágenes',
    'N2': 'Lector de sílabas',
    'N3': 'Lector de palabras',
    'N4': 'Lector no fluido',
    'N5': 'Lector fluido'
  };

  // Niveles de desempeño: (E), (A), (S)
  const PERF_LEVEL_MAP = {
    'E': 'Elemental',
    'A': 'Aceptable',
    'S': 'Satisfactorio'
  };

  const PERIODO = 'Mayo';

  /* ── Parser de CSV robusto (maneja comillas y comas internas) ─────────── */
  function parseCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    const result = [];
    for (const line of lines) {
      const row = [];
      let cur = '', inq = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          if (inq && line[i + 1] === '"') { cur += '"'; i++; }
          else inq = !inq;
        } else if (c === ',' && !inq) {
          row.push(cur.trim()); cur = '';
        } else {
          cur += c;
        }
      }
      row.push(cur.trim());
      result.push(row);
    }
    return result;
  }

  /* ── Extrae número de grado desde cabecera (G1 → 1, G6 → 6) ─────────── */
  function gradeFromHeader(h) {
    const m = h.match(/^G(\d)/);
    return m ? parseInt(m[1]) : null;
  }

  /* ── Extrae código de área desde cabecera (G1-LE-IND1.1 → 'LE') ──────── */
  function areaCodeFromHeader(h) {
    const m = h.match(/^G\d-([A-Z]+)-/);
    return m ? m[1] : null;
  }

  /* ── Extrae código de indicador (G1-LE-IND1.1 → 'IND1.1') ───────────── */
  function indCodeFromHeader(h) {
    const m = h.match(/-(IND[\d.]+)\s*\(/);
    return m ? m[1] : null;
  }

  /* ── Extrae nivel de desempeño desde cabecera (… (E) → 'E') ─────────── */
  function perfLevelFromHeader(h) {
    const m = h.match(/\(([EAS])\)\s*$/);
    return m ? m[1] : null;
  }

  /* ── Extrae nivel de lectura desde cabecera (G1-LT-N5 → 'N5') ────────── */
  function readLevelFromHeader(h) {
    const m = h.match(/-(N\d)\s*\(/);
    return m ? m[1] : null;
  }

  /* ── Convierte nombre de área a nombre canónico del dashboard ─────────── */
  function canonicalArea(areaCode) {
    return AREA_MAP[areaCode] || areaCode;
  }

  /* ── Construye el nombre de indicador canónico ────────────────────────── */
  // El dashboard usa cadenas como "IND1.1", "IND2.3", etc. directamente.
  function canonicalInd(indCode) {
    return indCode || '';
  }

  /* ── Construye nombre de competencia a partir del indicador ──────────── */
  // Convención del dashboard: "Competencia 1", "Competencia 2", etc.
  function compFromInd(indCode) {
    if (!indCode) return '';
    const m = indCode.match(/IND(\d)/);
    return m ? 'Competencia ' + m[1] : indCode;
  }

  /*
   * ── Intérprete de cabeceras ────────────────────────────────────────────
   * Devuelve objetos descriptores para cada columna:
   *
   *  { type: 'meta',    key: 'regional'|'distrito'|... }
   *  { type: 'matricula', grade: 1 }
   *  { type: 'evaluados', grade: 1 }
   *  { type: 'read',    grade: 1, level: 'Lector fluido' }
   *  { type: 'perf',    grade: 1, area: 'Matemática', comp: 'Competencia 1',
   *                     ind: 'IND1.1', level: 'Elemental' }
   *  { type: 'periodo' }
   *  { type: 'ignore' }
   */
  function parseHeader(h) {
    h = h.trim();
    const hl = h.toLowerCase();

    if (hl === 'código sigerd' || hl === 'codigo sigerd') return { type: 'meta', key: 'sigerd' };
    if (hl === 'regional')                                  return { type: 'meta', key: 'regional' };
    if (hl === 'distrito educativo')                        return { type: 'meta', key: 'distrito' };
    if (hl === 'centro educativo')                          return { type: 'meta', key: 'centro' };
    if (hl === 'sector')                                    return { type: 'meta', key: 'sector' };
    if (hl === 'tipo de centro')                            return { type: 'meta', key: 'tipo' };
    if (hl === 'tanda')                                     return { type: 'meta', key: 'tanda' };
    if (hl === 'periodo')                                   return { type: 'periodo' };

    // Matrícula Nto / Matricula Nro
    const mmat = h.match(/^Matr[ií]cula\s+(\d)/i);
    if (mmat) return { type: 'matricula', grade: parseInt(mmat[1]) };

    // Evaluados Nto / Evaluados Nro
    const mev = h.match(/^EVALUADOS\s+(\d)/i);
    if (mev) return { type: 'evaluados', grade: parseInt(mev[1]) };

    // Lectura: G1-LT-N5 (FLUIDO)
    const readLv = readLevelFromHeader(h);
    if (readLv && h.match(/^G\d-LT-N/i)) {
      const grade = gradeFromHeader(h);
      return { type: 'read', grade, level: READ_LEVEL_MAP[readLv] || readLv };
    }

    // Desempeño: G1-LE-IND1.1 (E)
    const perfLv = perfLevelFromHeader(h);
    if (perfLv) {
      const grade    = gradeFromHeader(h);
      const areaCode = areaCodeFromHeader(h);
      const indCode  = indCodeFromHeader(h);
      if (grade && areaCode && indCode) {
        return {
          type:  'perf',
          grade,
          area:  canonicalArea(areaCode),
          comp:  compFromInd(indCode),
          ind:   canonicalInd(indCode),
          level: PERF_LEVEL_MAP[perfLv]
        };
      }
    }

    return { type: 'ignore' };
  }

  /*
   * ── Procesador principal de un CSV parseado ───────────────────────────
   * Devuelve { covRows, perfRows, readRows }
   * en el mismo formato de arreglos numéricos que usa DATA internamente,
   * PERO usando strings directamente (no índices del diccionario D),
   * porque los inyectamos como filas "ya decodificadas".
   *
   * Para ser compatibles con matchBase / matchPerf / matchRead del dashboard,
   * que llaman a idText(r[N]) y esperan strings, inyectamos las filas con
   * una función idText que simplemente devuelve el valor si ya es string.
   * El dashboard hace: idText(r[0]) → si r[0] es string, idText lo devuelve tal cual.
   * Revisando el código: idText(id) devuelve D[id] si id es número, o 'id' si no está.
   * → Si ponemos strings directamente como valores, idText los devolverá sin cambios ✓
   */
  function processCiclo(rows) {
    if (rows.length < 2) return { covRows: [], perfBaseRows: [], perfCompRows: [], perfIndRows: [], readRows: [] };

    const headers = rows[0].map(parseHeader);
    const dataRows = rows.slice(1).filter(r => r.some(v => v !== ''));

    const covRows      = [];
    const perfBaseRows = [];
    const perfCompRows = [];
    const perfIndRows  = [];
    const readRows     = [];

    for (const row of dataRows) {
      // Leer campos de metadatos
      const meta = {};
      for (let i = 0; i < headers.length; i++) {
        const hd = headers[i];
        if (hd.type === 'meta')    meta[hd.key] = row[i] || '';
        if (hd.type === 'periodo') meta.periodo  = row[i] || PERIODO;
      }

      const periodo = meta.periodo || PERIODO;
      const regional = meta.regional || '';
      const distrito = meta.distrito || '';
      const centro   = meta.centro   || '';
      const sector   = meta.sector   || '';
      const tipo     = meta.tipo     || '';
      const tanda    = meta.tanda    || '';

      // ── Cobertura: una fila por grado presente en el CSV ─────────────
      // COV row format (según covAgg): [reg,dist,centro,sector,tipo,tanda,periodo,?,?,mat,ev]
      // Posiciones reales según el código:
      //   r[0]=reg r[1]=dist r[2]=centro r[3]=sector r[4]=tipo r[5]=tanda r[6]=periodo
      //   r[9]=mat r[10]=ev
      // Usamos length=11 para que gradeOf funcione también; grade va en r[7] o r[8].
      // gradeOf busca en r[7] y r[8] para length===11.

      const grades = new Set();
      for (let i = 0; i < headers.length; i++) {
        const hd = headers[i];
        if ((hd.type === 'matricula' || hd.type === 'evaluados') && hd.grade) {
          grades.add(hd.grade);
        }
      }

      for (const grade of grades) {
        let mat = 0, ev = 0;
        for (let i = 0; i < headers.length; i++) {
          const hd = headers[i];
          const val = parseFloat(row[i]) || 0;
          if (hd.type === 'matricula' && hd.grade === grade) mat += val;
          if (hd.type === 'evaluados' && hd.grade === grade) ev  += val;
        }
        if (mat > 0 || ev > 0) {
          // [reg,dist,centro,sector,tipo,tanda,periodo,grade,'',mat,ev]
          covRows.push([regional, distrito, centro, sector, tipo, tanda, periodo, grade, '', mat, ev]);
        }
      }

      // ── Lectura ───────────────────────────────────────────────────────
      // READ row format según matchRead/renderLectTable:
      //   r[0]=reg r[1]=dist r[2]=centro r[3]=sector r[4]=tipo r[5]=tanda
      //   r[6]=periodo  gradeOf(r) → r[7] o r[8]
      //   r[9]=nivel_lectura r[10]=cantidad
      // Agrupamos por grado+nivel
      const readMap = {};  // "grade|level" → count
      for (let i = 0; i < headers.length; i++) {
        const hd = headers[i];
        if (hd.type === 'read') {
          const key = hd.grade + '|' + hd.level;
          readMap[key] = (readMap[key] || 0) + (parseFloat(row[i]) || 0);
        }
      }
      for (const [key, val] of Object.entries(readMap)) {
        if (!val) continue;
        const [gradeStr, level] = key.split('|');
        const grade = parseInt(gradeStr);
        readRows.push([regional, distrito, centro, sector, tipo, tanda, periodo, grade, '', level, val]);
      }

      // ── Desempeño ─────────────────────────────────────────────────────
      // PERF_BASE row format (aggLevels usa idxL=12, idxV=13):
      //   r[0]=reg r[1]=dist r[2]=centro r[3]=sector r[4]=tipo r[5]=tanda
      //   r[6]=periodo  gradeOf → r[7]/r[8]
      //   r[9]=area r[10]=comp r[11]=ind
      //   r[12]=nivel r[13]=cantidad
      //
      // Para PERF_BASE (sin competencia ni indicador) agrupamos por grado+area+nivel.
      // Para PERF_COMP agrupamos por grado+area+comp+nivel.
      // Para PERF_IND agrupamos por grado+area+comp+ind+nivel.

      const perfBaseMap = {};  // "grade|area|level" → count
      const perfCompMap = {};  // "grade|area|comp|level" → count
      const perfIndMap  = {};  // "grade|area|comp|ind|level" → count

      for (let i = 0; i < headers.length; i++) {
        const hd = headers[i];
        if (hd.type === 'perf') {
          const val = parseFloat(row[i]) || 0;
          if (!val) continue;

          const kb = [hd.grade, hd.area, hd.level].join('|');
          perfBaseMap[kb] = (perfBaseMap[kb] || 0) + val;

          const kc = [hd.grade, hd.area, hd.comp, hd.level].join('|');
          perfCompMap[kc] = (perfCompMap[kc] || 0) + val;

          const ki = [hd.grade, hd.area, hd.comp, hd.ind, hd.level].join('|');
          perfIndMap[ki] = (perfIndMap[ki] || 0) + val;
        }
      }

      for (const [key, val] of Object.entries(perfBaseMap)) {
        if (!val) continue;
        const [gradeStr, area, level] = key.split('|');
        perfBaseRows.push([regional, distrito, centro, sector, tipo, tanda, periodo,
                           parseInt(gradeStr), '', area, '', '', level, val]);
      }

      for (const [key, val] of Object.entries(perfCompMap)) {
        if (!val) continue;
        const [gradeStr, area, comp, level] = key.split('|');
        perfCompRows.push([regional, distrito, centro, sector, tipo, tanda, periodo,
                           parseInt(gradeStr), '', area, comp, '', level, val]);
      }

      for (const [key, val] of Object.entries(perfIndMap)) {
        if (!val) continue;
        const [gradeStr, area, comp, ind, level] = key.split('|');
        perfIndRows.push([regional, distrito, centro, sector, tipo, tanda, periodo,
                          parseInt(gradeStr), '', area, comp, ind, level, val]);
      }
    }

    return { covRows, perfBaseRows, perfCompRows, perfIndRows, readRows };
  }

  /* ── Función de inyección en las estructuras del dashboard ───────────── */
  function injectData(processed) {
    // Inyectamos directamente en los arreglos globales.
    // El dashboard los lee via PERF_BASE, READ, COV (asignados desde DATA).
    // Como ya están cargados (loadData ya corrió), mutamos los arreglos existentes.

    const { covRows, perfBaseRows, perfCompRows, perfIndRows, readRows } = processed;

    // PERF_BASE
    if (window.PERF_BASE_MAYO_INJECTED !== true && Array.isArray(window.SIREV_MAYO_PERF_BASE)) {
      window.SIREV_MAYO_PERF_BASE.push(...perfBaseRows);
    }
    // READ
    if (Array.isArray(window.SIREV_MAYO_READ)) {
      window.SIREV_MAYO_READ.push(...readRows);
    }
    // COV
    if (Array.isArray(window.SIREV_MAYO_COV)) {
      window.SIREV_MAYO_COV.push(...covRows);
    }
    // PERF_COMP
    if (Array.isArray(window.SIREV_MAYO_PERF_COMP)) {
      window.SIREV_MAYO_PERF_COMP.push(...perfCompRows);
    }
    // PERF_IND
    if (Array.isArray(window.SIREV_MAYO_PERF_IND)) {
      window.SIREV_MAYO_PERF_IND.push(...perfIndRows);
    }

    window.MAYO_COV_ROWS      = (window.MAYO_COV_ROWS      || []).concat(covRows);
    window.MAYO_PERF_BASE     = (window.MAYO_PERF_BASE     || []).concat(perfBaseRows);
    window.MAYO_PERF_COMP     = (window.MAYO_PERF_COMP     || []).concat(perfCompRows);
    window.MAYO_PERF_IND      = (window.MAYO_PERF_IND      || []).concat(perfIndRows);
    window.MAYO_READ          = (window.MAYO_READ          || []).concat(readRows);
  }

  /*
   * ── Parche sobre loadData ──────────────────────────────────────────────
   * Este módulo debe cargarse ANTES del script principal.
   * Envuelve window.loadData para que, después de que el dashboard cargue
   * sus datos comprimidos, se añadan los datos de Mayo y se actualice el render.
   */
  function patchDashboard() {
    const originalLoadData = window.loadData;

    window.loadData = async function () {
      // 1. Cargar los datos base del dashboard (periodos anteriores)
      originalLoadData();

      // 2. Cargar los CSVs de Mayo en paralelo
      let statuses = { c1: 'loading', c2: 'loading' };

      async function fetchCiclo(url, ciclo) {
        try {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const text = await resp.text();
          const rows = parseCSV(text);
          const processed = processCiclo(rows);
          statuses['c' + ciclo] = 'ok';
          return processed;
        } catch (e) {
          console.warn('[SIREV Mayo] No se pudo cargar el CSV del ciclo ' + ciclo + ':', e.message);
          statuses['c' + ciclo] = 'error';
          return { covRows: [], perfBaseRows: [], perfCompRows: [], perfIndRows: [], readRows: [] };
        }
      }

      const [p1, p2] = await Promise.all([fetchCiclo(URL_CICLO1, 1), fetchCiclo(URL_CICLO2, 2)]);

      // 3. Combinar resultados de ambos ciclos
      const combined = {
        covRows:      [...p1.covRows,      ...p2.covRows],
        perfBaseRows: [...p1.perfBaseRows, ...p2.perfBaseRows],
        perfCompRows: [...p1.perfCompRows, ...p2.perfCompRows],
        perfIndRows:  [...p1.perfIndRows,  ...p2.perfIndRows],
        readRows:     [...p1.readRows,     ...p2.readRows],
      };

      if (combined.covRows.length === 0 && combined.perfBaseRows.length === 0) {
        console.warn('[SIREV Mayo] No se obtuvieron datos de Mayo desde los CSVs.');
        return;
      }

      // 4. Esperar a que DATA esté disponible (loadData es síncrono pero puede demorar el decode)
      await waitForData();

      // 5. Inyectar en las estructuras del dashboard
      window.DATA.perf_base  = window.DATA.perf_base  || [];
      window.DATA.perf_comp  = window.DATA.perf_comp  || [];
      window.DATA.read       = window.DATA.read        || [];
      window.DATA.cov        = window.DATA.cov         || [];

      window.DATA.perf_base.push(...combined.perfBaseRows);
      window.DATA.perf_comp.push(...combined.perfCompRows);
      window.DATA.read.push(...combined.readRows);
      window.DATA.cov.push(...combined.covRows);

      // PERF_IND se carga bajo demanda; guardamos las filas para inyectarlas cuando se pida
      window._MAYO_PERF_IND_PENDING = combined.perfIndRows;

      // Parchear ensureIndLoaded para que también inyecte los datos de Mayo
      const originalEnsureInd = window.ensureIndLoaded;
      window.ensureIndLoaded = function () {
        const result = originalEnsureInd();
        if (result && window._MAYO_PERF_IND_PENDING && window._MAYO_PERF_IND_PENDING.length) {
          if (Array.isArray(window.PERF_IND)) {
            window.PERF_IND.push(...window._MAYO_PERF_IND_PENDING);
          }
          window._MAYO_PERF_IND_PENDING = [];
        }
        return result;
      };

      // 6. Re-sincronizar las variables globales del dashboard con DATA actualizado
      window.PERF_BASE = window.DATA.perf_base;
      window.PERF_COMP = window.DATA.perf_comp;
      window.READ      = window.DATA.read;
      window.COV       = window.DATA.cov;

      // 7. Re-renderizar si el dashboard ya estaba inicializado
      if (typeof window.apply === 'function') {
        // Reconstruir filtros de periodo para incluir Mayo
        if (typeof window.buildPeriodButtons === 'function') buildPeriodButtons();
        if (typeof window.setupFilters       === 'function') setupFilters();
        apply();
        console.info('[SIREV Mayo] Datos de Mayo inyectados. Filas COV:', combined.covRows.length,
                     '| PerfBase:', combined.perfBaseRows.length,
                     '| Read:', combined.readRows.length);
      }
    };
  }

  /* Espera a que window.DATA esté disponible (poll ligero) */
  function waitForData(maxMs = 15000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const id = setInterval(() => {
        if (window.DATA && window.DATA.cov) {
          clearInterval(id);
          resolve();
        } else if (Date.now() - start > maxMs) {
          clearInterval(id);
          reject(new Error('Timeout esperando DATA'));
        }
      }, 80);
    });
  }

  /* ── Punto de entrada ─────────────────────────────────────────────────── */
  // El parche se aplica inmediatamente (este script carga antes que el principal)
  patchDashboard();

  console.info('[SIREV Mayo] Módulo de integración cargado. Esperando inicialización del dashboard.');

})();
