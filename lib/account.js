'use strict';
/**
 * Métadonnées d'un compte pour l'export : commercial (propriétaire du compte)
 * et contact client principal (Contact le plus récent rattaché au compte).
 */
const sf = require('./sf');

function soqlEscape(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

async function meta(accountId) {
  const id = soqlEscape(accountId.trim());
  const out = { commercial: null, client: null, compteNom: null };

  try {
    const accs = await sf.query(`SELECT Name, Owner.Name, Owner.Email, Owner.Phone FROM Account WHERE Id = '${id}' LIMIT 1`);
    if (accs.length) {
      const a = accs[0];
      out.compteNom = a.Name || null;
      if (a.Owner) out.commercial = { name: a.Owner.Name || null, email: a.Owner.Email || null, phone: a.Owner.Phone || null };
    }
  } catch (e) { /* ignore */ }

  try {
    const cts = await sf.query(`SELECT Name, Email, Phone FROM Contact WHERE AccountId = '${id}' ORDER BY CreatedDate DESC LIMIT 1`);
    if (cts.length) {
      const c = cts[0];
      out.client = { name: c.Name || null, email: c.Email || null, phone: c.Phone || null };
    }
  } catch (e) { /* ignore */ }

  return out;
}

module.exports = { meta };
