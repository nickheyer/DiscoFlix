// OVERVIEW SECTION VIEW MODEL - THE "ABOUT THIS APP" PAGE EVERY SERVICE KIND
// SHARES. ONE PAYLOAD SHAPE FOR THE TEMPLATE: AN ABOUT HEADER, A NOTICE LIST,
// A STAT-TILE ROW, AND ONE KIND-SPECIFIC SECTION. LIVE HTTP ONLY RUNS BEHIND
// status.ok AND EVERY CALL IS GUARDED - A DEAD SERVICE RENDERS CACHED TILES
// AND DASHES, NEVER A HUNG PAGE.
const BaseClient = require('../../core/methods/apps/clients/baseClient');

// 'movie' -> 'Movies' FOR STAT-TILE LABELS
function pluralLabel(label) {
  const clean = String(label || 'item');
  return `${clean.charAt(0).toUpperCase()}${clean.slice(1)}s`;
}

// 1234567 -> '1.2M' FOR TOKEN-COUNT TILES
function compactCount(value) {
  const num = Number(value) || 0;
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}k`;
  return num;
}

// DISK ROWS -> METER ROWS. ENTRIES WITHOUT A TOTAL ARE NOISE (RAMDISKS,
// UNRESOLVED MOUNTS) AND DROP OUT.
function storageRowsFrom(disks) {
  return (disks || [])
    .filter(disk => Number(disk.totalSpace) > 0)
    .map(disk => {
      const total = Number(disk.totalSpace);
      const free = Math.max(0, Number(disk.freeSpace) || 0);
      const percentUsed = BaseClient.clampPercent(((total - free) / total) * 100);
      return {
        label: disk.label || disk.path || 'Disk',
        freeHuman: BaseClient.humanSize(free) || '0 B',
        totalHuman: BaseClient.humanSize(total),
        percentUsed,
        level: percentUsed >= 95 ? 'danger' : percentUsed >= 85 ? 'warn' : ''
      };
    });
}

async function buildOverviewData(core, instance) {
  const client = core.apps.getClientForInstance(instance);
  const manifest = core.apps.getType(instance.app_type) || {};
  const configured = !!client;
  const data = {
    configured,
    appUrl: configured ? client.baseUrl : null,
    kind: manifest.kind || 'app',
    blurb: manifest.blurb || null,
    disabled: !instance.enabled,
    status: { ok: false },
    notices: [],
    stats: [],
    storage: null,
    activeDownloads: null,
    nowPlaying: null,
    indexers: null
  };
  if (!configured) return data;

  data.status = core.apps.statusCache.get(instance.id)
    || await core.apps.testInstance(instance);
  if (!data.status.ok) {
    data.notices.push({ type: 'error', message: data.status.error || `${instance.display_name} is unreachable` });
  }
  if (data.disabled) {
    data.notices.push({ type: 'warning', message: `${instance.display_name} is disabled - the bot and heartbeat leave it alone until it is re-enabled` });
  }

  const queueRows = core.apps.queueCache.get(instance.id) || [];

  switch (manifest.kind) {
    case 'content-manager': {
      if (data.status.ok && client.capabilities.health) {
        try {
          data.notices.push(...(await client.getHealth()).map(item => ({
            type: item.type === 'error' ? 'error' : 'warning',
            message: item.message || String(item)
          })));
        } catch (err) {
          core.logger.warn(`${instance.display_name} health fetch failed: ${err.message}`);
        }
      }
      const counts = await core.apps.getLibraryCounts(instance);
      data.stats = [
        { value: counts ? counts.total : null, label: pluralLabel(manifest.contentTypes[0]?.label) },
        { value: counts ? counts.missing : null, label: 'Missing', attention: !!(counts && counts.missing) },
        { value: counts ? counts.monitored : null, label: 'Monitored' },
        { value: queueRows.length, label: 'In Queue' }
      ];
      data.countsWarming = !counts && data.status.ok;
      if (data.status.ok && client.capabilities.diskSpace) {
        try {
          data.storage = storageRowsFrom(await client.getDiskSpace());
        } catch (err) {
          core.logger.debug(`${instance.display_name} diskspace fetch failed: ${err.message}`);
        }
      }
      break;
    }
    case 'download-client': {
      const downloading = queueRows.filter(row => row.status === 'downloading');
      const speedBps = client.aggregateQueueSpeed(queueRows);
      const remaining = queueRows.reduce((sum, row) => sum + (Number(row.sizeleft) || 0), 0);
      data.stats = [
        { value: downloading.length, label: 'Downloading' },
        { value: queueRows.length - downloading.length, label: 'Queued' },
        { value: speedBps > 0 ? BaseClient.humanSpeed(speedBps) : '0 B/s', label: 'Speed' },
        { value: remaining > 0 ? BaseClient.humanSize(remaining) : null, label: 'Remaining' },
        { value: speedBps > 0 && remaining > 0 ? BaseClient.humanEta(remaining / speedBps) : null, label: 'ETA' }
      ];
      data.activeDownloads = [...queueRows]
        .sort((a, b) => (b.percent || 0) - (a.percent || 0))
        .slice(0, 3);
      break;
    }
    case 'media-server': {
      let sessionCount = null;
      if (data.status.ok && client.capabilities.sessions) {
        const { sessions } = await core.apps.getSessionsFor(instance);
        sessionCount = sessions.length;
        data.nowPlaying = sessions.slice(0, 3);
      }
      const counts = await core.apps.getLibraryCounts(instance);
      data.stats = [
        { value: sessionCount, label: 'Streaming Now' },
        { value: counts ? counts.byKind.movie || 0 : null, label: 'Movies' },
        { value: counts ? counts.byKind.show || 0 : null, label: 'Shows' },
        { value: counts ? counts.total : null, label: 'Titles' }
      ];
      data.countsWarming = !counts && data.status.ok;
      break;
    }
    case 'ai-provider': {
      let settings = {};
      try { settings = JSON.parse(instance.settings_json || '{}'); } catch (err) { settings = {}; }
      const [totals, threadCount] = await Promise.all([
        core.models.aiMessage.usageTotalsFor(instance.id),
        core.models.aiConversation.countFor(instance.id)
      ]);
      data.aiModel = settings.model || client.defaultModel || 'auto';
      data.stats = [
        { value: threadCount, label: 'Conversations' },
        { value: totals.turns, label: 'AI Replies' },
        { value: compactCount(totals.input), label: 'Tokens In' },
        { value: compactCount(totals.output), label: 'Tokens Out' }
      ];
      break;
    }
    case 'indexer': {
      if (data.status.ok) {
        try {
          data.indexers = await client.getIndexers();
        } catch (err) {
          core.logger.debug(`${instance.display_name} indexer roster failed: ${err.message}`);
        }
      }
      // JACKETT'S ROSTER DOUBLES AS ITS HEALTH LIST - ERRORED TRACKERS RENDER
      // RED IN THE ROSTER, SO A SEPARATE getHealth PASS WOULD SAY IT TWICE
      if (data.indexers) {
        const failing = data.indexers.filter(row => row.error).length;
        data.stats = [
          { value: data.indexers.length, label: 'Indexers' },
          { value: failing, label: 'Failing', attention: failing > 0 }
        ];
      }
      break;
    }
    default:
      break;
  }
  return data;
}

module.exports = { buildOverviewData };
