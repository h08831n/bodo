#!/usr/bin/env node
import { getDbConfig, connectWithRetry, formatDbError } from './db-env.mjs';

async function verifyDevDb() {
  const config = getDbConfig();
  console.log(`[db:verify-dev] Connecting to "${config.targetDb}" as role "${config.app.user}"...`);

  let conn;
  try {
    conn = await connectWithRetry(config.getAppUrl(), {
      maxAttempts: 15,
      delayMs: 1000,
    });
  } catch (err) {
    const formatted = formatDbError(err, config.host, config.port);
    console.error('[db:verify-dev] Connection Failure:');
    console.error(formatted);
    console.log(`::error title=VerifyConnError::${String(err.message || err).replace(/[\r\n]+/g, ' ')}`);
    process.exit(1);
  }

  const { pool, client } = conn;
  try {
    const infoRes = await client.query('SELECT current_database(), current_user;');
    console.log(`[db:verify-dev] Connected DB Info:`, infoRes.rows[0]);
    console.log(`::warning title=VerifyDbInfo::${JSON.stringify(infoRes.rows[0])}`);

    const curRes = await client.query('SELECT code, name, decimals FROM currencies ORDER BY sort_order;');
    console.log(`[db:verify-dev] Currencies (${curRes.rowCount}):`);
    for (const r of curRes.rows) {
      console.log(`  - ${r.code}: ${r.name} (${r.decimals} decimals)`);
    }

    if (curRes.rowCount !== 4) {
      throw new Error(`Expected 4 currencies, found ${curRes.rowCount}`);
    }

    const reasonsRes = await client.query('SELECT name, applies_to FROM lost_reasons ORDER BY sort_order;');
    console.log(`[db:verify-dev] Lost Reasons (${reasonsRes.rowCount}):`);
    for (const r of reasonsRes.rows) {
      console.log(`  - ${r.name} (${r.applies_to})`);
    }

    if (reasonsRes.rowCount !== 7) {
      throw new Error(`Expected 7 lost reasons, found ${reasonsRes.rowCount}`);
    }

    console.log(`\n[db:verify-dev] SUCCESS: Database "${config.targetDb}" verified with 4 currencies and 7 lost reasons!`);
  } catch (err) {
    console.error('[db:verify-dev] ERROR:', err.message);
    console.log(`::error title=VerifyQueryError::${String(err.message || err).replace(/[\r\n]+/g, ' ')}`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

verifyDevDb().catch((err) => {
  console.error('[db:verify-dev] FATAL ERROR:', err);
  console.log(`::error title=VerifyFatalError::${String(err.message || err).replace(/[\r\n]+/g, ' ')}`);
  process.exit(1);
});
