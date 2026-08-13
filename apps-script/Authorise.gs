/**
 * Pre-approving the IMPORTRANGE links this planner depends on.
 *
 * A fresh copy of the template has to be told, once per source workbook, that
 * it may pull from it — otherwise every IMPORTRANGE returns #REF! until someone
 * clicks "Allow access" in the cell. That click is easy to miss, and missing it
 * is not harmless: the Tactical floor arrives as #REF!, and a floor that cannot
 * be read used to read as no floor at all.
 *
 * Google exposes no supported API for this. The endpoint below is the one the
 * Sheets front-end itself calls when you click Allow, driven with the script's
 * own OAuth token. It is undocumented, so it is written to fail softly: a
 * refusal here is reported, never thrown, and the run still refuses to draw on
 * a floor it cannot see.
 */

/**
 * Grant this spreadsheet permission to import from every known source.
 * Returns [{ id, ok, status }] — one entry per donor, in the order tried.
 */
function authoriseDataSources(planner, cfg) {
  var ss = planner || SpreadsheetApp.getActiveSpreadsheet();
  var conf = cfg || config();
  var donors = donorIds(ss, conf);
  var token = ScriptApp.getOAuthToken();
  var destId = ss.getId();

  return donors.map(function (donorId) {
    var url = 'https://docs.google.com/spreadsheets/d/' + destId
      + '/externaldata/addimportrangepermissions?donorDocId=' + donorId;
    try {
      var res = UrlFetchApp.fetch(url, {
        method: 'post',
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true,
      });
      var code = res.getResponseCode();
      return { id: donorId, ok: code >= 200 && code < 300, status: 'HTTP ' + code };
    } catch (e) {
      return { id: donorId, ok: false, status: e.message };
    }
  });
}

/**
 * Every workbook this planner imports from: the ones named in Config, plus any
 * other ID found inside an IMPORTRANGE on the sheet.
 *
 * Scanning the formulas matters more than the configured list — someone adds an
 * IMPORTRANGE to a tab long before anyone thinks to add its ID here, and the
 * symptom of missing one is a silent #REF! rather than an error.
 */
function donorIds(ss, cfg) {
  var seen = {};
  var out = [];
  function add(id) {
    if (!id || id === ss.getId() || seen[id]) return;
    seen[id] = true;
    out.push(id);
  }

  [cfg.SOURCES.IMS_ID, cfg.SOURCES.MIN_UNITS_ID].forEach(add);
  (cfg.SOURCES.EXTRA_IMPORT_SOURCES || []).forEach(add);

  ss.getSheets().forEach(function (sh) {
    // getFormulas() on a Connected Sheet throws; it holds no IMPORTRANGE anyway.
    if (!isGridSheet(sh)) return;
    if (sh.getLastRow() < 1 || sh.getLastColumn() < 1) return;
    var formulas;
    try {
      formulas = sh.getRange(1, 1, Math.min(sh.getLastRow(), 200),
        sh.getLastColumn()).getFormulas();
    } catch (e) {
      return;
    }
    formulas.forEach(function (row) {
      row.forEach(function (f) {
        if (!f || f.indexOf('IMPORTRANGE') === -1) return;
        var m = f.match(/[-\w]{25,}/g);
        if (m) m.forEach(add);
      });
    });
  });

  return out;
}

/** Menu entry: authorise, then say what happened. */
function authoriseDataSourcesMenu() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var results = authoriseDataSources(ss, config());
  var ui = SpreadsheetApp.getUi();

  if (!results.length) {
    ui.alert('Nothing to authorise', 'No IMPORTRANGE sources found in this file.',
      ui.ButtonSet.OK);
    return results;
  }

  var lines = results.map(function (r) {
    return (r.ok ? '✓ ' : '✗ ') + r.id + '  (' + r.status + ')';
  });
  var failed = results.filter(function (r) { return !r.ok; }).length;
  lines.unshift(results.length - failed + ' of ' + results.length + ' authorised.', '');
  if (failed) {
    lines.push('', 'For any that failed, open the cell showing #REF! and click',
      '"Allow access" once. That grant is per source workbook and sticks.');
  }
  ui.alert('Data sources', lines.join('\n'), ui.ButtonSet.OK);
  return results;
}
