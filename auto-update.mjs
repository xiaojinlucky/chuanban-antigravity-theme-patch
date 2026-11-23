import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_URL = 'https://github.com/Anarcadia/chuanban-antigravity-theme-patch.git';
const LOG_FILE = path.join(__dirname, 'update.log');
const HASH_FILE = path.join(__dirname, 'current-commit.txt');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line, 'utf8');
  console.log(line.trim());
}

const REQUIRED_ZH_BRIDGE_MARKERS = [
  'zhTitleCtrl',
  'createZhTitleController',
  '__agTitleSync',
  'zhTitleCtrl?.onTargetAttached',
  'zhTitleCtrl?.onBindingCalled',
  'zhTitleCfg'
];

export function detectUpstreamNativeZhTitle(repoDir, daemonCode) {
  try {
    const runtimePath = path.join(repoDir, 'core', 'runtime.js');
    const runtimeCode = fs.existsSync(runtimePath) ? fs.readFileSync(runtimePath, 'utf8') : '';
    const hasNativeDaemonSupport =
      /\bzhTitle\b|\bzh-title\b|\bsidebarTitleGen\b|\bconversationTitleGen\b/.test(String(daemonCode || '')) &&
      !String(daemonCode || '').includes('Optional zh-title-engine load skipped');
    const hasNativeRuntimeSupport = /\bconversation.*zhTitle\b|\b__ag_zh_titles\b/i.test(runtimeCode);
    return hasNativeDaemonSupport || hasNativeRuntimeSupport;
  } catch {
    return false;
  }
}

export function verifyZhTitleBridgeMarkers(daemonCode) {
  const code = String(daemonCode || '');
  return REQUIRED_ZH_BRIDGE_MARKERS.filter((marker) => !code.includes(marker));
}

export function applyZhTitleBridge(daemonCode, warnLog = log) {
  if (typeof daemonCode !== 'string' || !daemonCode) return daemonCode;
  let nextCode = daemonCode;

  try {
    // 1. Ensure module defaults & zhTitle config propagation in activeConfig + rebuildBundleIfNeeded
    if (!/modules:\s*\{[^}]*\bzhTitle:\s*true[^}]*\},\r?\n\s*themeVars:/.test(nextCode)) {
      const reActiveModules =
        /([ \t]*customJs:\s*true)(\r?\n[ \t]*\},\r?\n[ \t]*themeVars:\s*\{\},\r?\n[ \t]*darkThemeVars:\s*\{\},)/;
      if (reActiveModules.test(nextCode)) {
        nextCode = nextCode.replace(
          reActiveModules,
          (_, p1, p2) => `${p1},\n    zhTitle: true${p2}\n  zhTitle: {},`
        );
      } else {
        warnLog('[Warn] applyZhTitleBridge: activeConfig.modules anchor not found; skipping.');
      }
    }

    if (!/Object\.assign\(\s*\{[^}]*\bzhTitle:\s*true[^}]*\},\s*rawModules/.test(nextCode)) {
      const reRebuildModules = /([ \t]*customJs:\s*true)(\r?\n[ \t]*\},\r?\n[ \t]*rawModules)/;
      if (reRebuildModules.test(nextCode)) {
        nextCode = nextCode.replace(reRebuildModules, (_, p1, p2) => `${p1},\n      zhTitle: true${p2}`);
      } else {
        warnLog('[Warn] applyZhTitleBridge: rebuildBundleIfNeeded modules anchor not found; skipping.');
      }
    }

    if (!nextCode.includes('const zhTitleCfg =')) {
      const reDarkVars =
        /(const darkThemeVars =\r?\n\s*!SAFE_MODE && userCfg\.darkThemeVars && typeof userCfg\.darkThemeVars === 'object' \? userCfg\.darkThemeVars : \{\};)/;
      if (reDarkVars.test(nextCode)) {
        nextCode = nextCode.replace(
          reDarkVars,
          (_, p1) =>
            `${p1}\n  const zhTitleCfg =\n    !SAFE_MODE && userCfg.zhTitle && typeof userCfg.zhTitle === 'object' ? userCfg.zhTitle : {};`
        );
      } else {
        warnLog('[Warn] applyZhTitleBridge: darkThemeVars anchor not found; skipping zhTitleCfg propagation.');
      }
    }

    if (nextCode.includes('const zhTitleCfg =')) {
      if (!/activeConfig\s*=\s*\{[^;]*\bzhTitle:\s*zhTitleCfg/.test(nextCode)) {
        const reActiveAssign = /(activeConfig\s*=\s*\{[\s\S]*?themeVars,\r?\n[ \t]*darkThemeVars,)/;
        if (reActiveAssign.test(nextCode)) {
          nextCode = nextCode.replace(reActiveAssign, (_, p1) => `${p1}\n    zhTitle: zhTitleCfg,`);
        } else {
          warnLog('[Warn] applyZhTitleBridge: activeConfig assignment anchor not found.');
        }
      }

      if (!/\.update\(\s*\r?\n\s*JSON\.stringify\(\{[^}]*\bzhTitle:\s*zhTitleCfg/.test(nextCode)) {
        const reHashUpdate = /(\.update\(\s*\r?\n\s*JSON\.stringify\(\{[^}]*themeVars,\r?\n[ \t]*darkThemeVars,)/;
        if (reHashUpdate.test(nextCode)) {
          nextCode = nextCode.replace(reHashUpdate, (_, p1) => `${p1}\n        zhTitle: zhTitleCfg,`);
        } else {
          warnLog('[Warn] applyZhTitleBridge: bundle hash JSON.stringify anchor not found.');
        }
      }

      if (!/bootPayload\s*=\s*\{[\s\S]*?config:\s*\{[^}]*\bzhTitle:\s*zhTitleCfg/.test(nextCode)) {
        const reBootCfg =
          /(const bootPayload\s*=\s*\{[\s\S]*?config:\s*\{[^}]*themeVars,\r?\n[ \t]*darkThemeVars)(?=\r?\n[ \t]*\})/;
        if (reBootCfg.test(nextCode)) {
          nextCode = nextCode.replace(reBootCfg, (_, p1) => `${p1},\n      zhTitle: zhTitleCfg`);
        } else {
          warnLog('[Warn] applyZhTitleBridge: bootPayload.config anchor not found.');
        }
      }
    }

    // 2. Transactional dynamic bridge to optional user/zh-title-engine.mjs
    const preBridgeCode = nextCode;
    const missingBridgeAnchors = [];

    if (!/\bpathToFileURL\b/.test(nextCode)) {
      const reUrlImport = /import\s*\{([^}]+)\}\s*from\s*'node:url';/;
      if (reUrlImport.test(nextCode)) {
        nextCode = nextCode.replace(
          reUrlImport,
          (_, inner) => `import { ${inner.trim()}, pathToFileURL } from 'node:url';`
        );
      } else {
        missingBridgeAnchors.push('node:url import');
      }
    }

    if (!nextCode.includes('let zhTitleCtrl = null;')) {
      const reAttachedMap = /const attachedTargets = new Map\(\);/;
      if (reAttachedMap.test(nextCode)) {
        nextCode = nextCode.replace(reAttachedMap, () =>
          [
            'const attachedTargets = new Map();',
            'let zhTitleCtrl = null;',
            '',
            'function getZhConfigSig(cfg = activeConfig) {',
            '  return JSON.stringify({',
            '    enabled: cfg?.enabled !== false,',
            '    zhTitleModule: cfg?.modules?.zhTitle !== false,',
            '    zhTitle: cfg?.zhTitle || {}',
            '  });',
            '}',
            '',
            'async function broadcastEval(expr) {',
            '  const tasks = [];',
            '  for (const [, t] of attachedTargets.entries()) {',
            '    if (',
            '      t &&',
            "      t.type === 'page' &&",
            '      t.hostConfirmed &&',
            '      t.ws?.readyState === WebSocket.OPEN &&',
            "      typeof t.send === 'function'",
            '    ) {',
            '      tasks.push(',
            "        Promise.resolve(t.send('Runtime.evaluate', { expression: expr, returnByValue: false })).catch(() => null)",
            '      );',
            '    }',
            '  }',
            '  if (tasks.length > 0) {',
            '    await Promise.allSettled(tasks);',
            '  }',
            '}'
          ].join('\n')
        );
      } else {
        missingBridgeAnchors.push('attachedTargets map');
      }
    }

    if (!nextCode.includes('createZhTitleController')) {
      const rePidEnd = /(logDaemonEvent\(`PID lock init warning: \$\{err\?\.message \|\| err\}`\);\r?\n[ \t]*\}\r?\n\})/;
      if (rePidEnd.test(nextCode)) {
        nextCode = nextCode.replace(rePidEnd, (_, p1) =>
          [
            p1,
            '',
            'if (!SAFE_MODE) {',
            '  try {',
            "    const zhEnginePath = path.join(USER_DIR, 'zh-title-engine.mjs');",
            '    if (fs.existsSync(zhEnginePath)) {',
            '      const zhMod = await import(pathToFileURL(zhEnginePath).href);',
            "      if (zhMod && typeof zhMod.createZhTitleController === 'function') {",
            '        zhTitleCtrl = zhMod.createZhTitleController({',
            '          rootDir: ROOT_DIR,',
            '          userDir: USER_DIR,',
            '          getActiveConfig: () => activeConfig,',
            '          broadcastEval',
            '        });',
            '      }',
            '    }',
            '  } catch (err) {',
            "    console.error('[Daemon] Optional zh-title-engine load skipped:', err?.message || err);",
            '    zhTitleCtrl = null;',
            '  }',
            '}'
          ].join('\n')
        );
      } else {
        missingBridgeAnchors.push('PID lock init block');
      }
    }

    if (!/function shutdownDaemon[\s\S]*?zhTitleCtrl\?\.dispose\?\.\(\);/.test(nextCode)) {
      const reShutdown = /(function shutdownDaemon\([^\)]*\)\s*\{[\s\S]*?logDaemonEvent\(reason\);)/;
      if (reShutdown.test(nextCode)) {
        nextCode = nextCode.replace(
          reShutdown,
          (_, p1) => `${p1}\n  try {\n    zhTitleCtrl?.dispose?.();\n  } catch {}`
        );
      } else {
        missingBridgeAnchors.push('shutdownDaemon');
      }
    }

    if (!/const cleanPid = \(\) => \{\s*\r?\n\s*try \{\s*\r?\n\s*zhTitleCtrl\?\.dispose\?\.\(\);/.test(nextCode)) {
      const reCleanPid = /(const cleanPid = \(\) => \{)/;
      if (reCleanPid.test(nextCode)) {
        nextCode = nextCode.replace(
          reCleanPid,
          (_, p1) => `${p1}\n      try {\n        zhTitleCtrl?.dispose?.();\n      } catch {}`
        );
      }
    }

    if (!/if \(RUN_ONCE\) \{\s*\r?\n\s*try \{\s*\r?\n\s*zhTitleCtrl\?\.dispose\?\.\(\);/.test(nextCode)) {
      const reRunOnce = /(if \(RUN_ONCE\) \{)/;
      if (reRunOnce.test(nextCode)) {
        nextCode = nextCode.replace(
          reRunOnce,
          (_, p1) => `${p1}\n  try {\n    zhTitleCtrl?.dispose?.();\n  } catch {}`
        );
      }
    }

    if (!nextCode.includes("name: '__agTitleSync'")) {
      const reSetDarkBinding = /([ \t]*await send\('Runtime\.addBinding', \{ name: '__agSetDarkPreset' \}\);)/;
      if (reSetDarkBinding.test(nextCode)) {
        nextCode = nextCode.replace(
          reSetDarkBinding,
          (_, p1) => `${p1}\n            await send('Runtime.addBinding', { name: '__agTitleSync' });`
        );
      } else {
        missingBridgeAnchors.push('promoteToHost addBinding');
      }
    }

    if (!nextCode.includes('zhTitleCtrl?.onTargetAttached')) {
      const rePromoteMetrics =
        /(await updateNewDocScript\([^)]*\);\r?\n[ \t]*const ok = await inject\(\);(?:\r?\n[ \t]*if \(target\.type === 'page'\) \{)?\r?\n[ \t]*await syncMetricsForSession\(true\);(?:\r?\n[ \t]*\})?)/;
      if (rePromoteMetrics.test(nextCode)) {
        nextCode = nextCode.replace(rePromoteMetrics, (_, p1) =>
          [
            p1,
            "        if (target.type === 'page' && !SAFE_MODE && activeConfig.enabled) {",
            '          try {',
            '            const p = Promise.resolve(zhTitleCtrl?.onTargetAttached?.(target.id, send)).catch((err) => {',
            '              logDaemonEvent(`zhTitle onTargetAttached error: ${err?.message || err}`);',
            '            });',
            '            if (RUN_ONCE) await p;',
            '          } catch (err) {',
            '            logDaemonEvent(`zhTitle onTargetAttached sync error: ${err?.message || err}`);',
            '          }',
            '        }'
          ].join('\n')
        );
      } else {
        missingBridgeAnchors.push('promoteToHost onTargetAttached');
      }
    }

    if (!nextCode.includes("msg.params?.name === '__agTitleSync'")) {
      const reDarkMsg =
        /(if \(msg\.method === 'Runtime\.bindingCalled' && msg\.params\?\.name === '__agSetDarkPreset'\) \{(?:[^\r\n]*\r?\n){1,12}[ \t]*return;\r?\n[ \t]*\})/;
      if (reDarkMsg.test(nextCode)) {
        nextCode = nextCode.replace(reDarkMsg, (_, p1) =>
          [
            p1,
            "          if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__agTitleSync') {",
            "            if (!hostConfirmed || target.type !== 'page' || SAFE_MODE || !activeConfig.enabled) {",
            '              return;',
            '            }',
            '            try {',
            '              Promise.resolve(zhTitleCtrl?.onBindingCalled?.(target.id, msg.params.payload, send)).catch((err) => {',
            '                logDaemonEvent(`zhTitle onBindingCalled error: ${err?.message || err}`);',
            '              });',
            '            } catch (err) {',
            '              logDaemonEvent(`zhTitle onBindingCalled sync error: ${err?.message || err}`);',
            '            }',
            '            return;',
            '          }'
          ].join('\n')
        );
      } else {
        missingBridgeAnchors.push('Runtime.bindingCalled __agTitleSync');
      }
    }

    if (!/attachedTargets\.set\(target\.id,\s*\{\s*\r?\n\s*ws,\s*\r?\n\s*type:\s*target\.type,/.test(nextCode)) {
      const reAttachedSet = /(attachedTargets\.set\(target\.id,\s*\{\s*\r?\n[ \t]*ws,)(\r?\n[ \t]*send,)/;
      if (reAttachedSet.test(nextCode)) {
        nextCode = nextCode.replace(reAttachedSet, (_, p1, p2) => `${p1}\n        type: target.type,${p2}`);
      } else {
        missingBridgeAnchors.push('attachedTargets.set type');
      }
    }

    if (!nextCode.includes('zhConfigChanged')) {
      const reSyncRebuild = /(const bundleChanged = rebuildBundleIfNeeded\(\);)/;
      const reSyncAfterAttach =
        /(if \(attachPromises\.length > 0\) \{\r?\n[ \t]*await Promise\.allSettled\(attachPromises\);\r?\n[ \t]*\})/;
      if (reSyncRebuild.test(nextCode) && reSyncAfterAttach.test(nextCode)) {
        nextCode = nextCode.replace(
          reSyncRebuild,
          (_, p1) =>
            `const prevZhSig = getZhConfigSig(activeConfig);\n    ${p1}\n    const zhConfigChanged = bundleChanged && getZhConfigSig(activeConfig) !== prevZhSig;`
        );
        nextCode = nextCode.replace(reSyncAfterAttach, (_, p1) =>
          [
            p1,
            '',
            '    if (zhConfigChanged && !SAFE_MODE) {',
            '      try {',
            '        Promise.resolve(zhTitleCtrl?.onConfigChanged?.(activeConfig)).catch(() => {});',
            '      } catch {}',
            '      if (!activeConfig.enabled || activeConfig.modules?.zhTitle === false || activeConfig.zhTitle?.enabled === false) {',
            '        void broadcastEval(\'window.__ag_apply_zh_titles && window.__ag_apply_zh_titles({"enabled":false,"titles":{}})\');',
            '      } else {',
            '        for (const [id, entry] of attachedTargets.entries()) {',
            "          if (entry?.type === 'page' && entry.hostConfirmed && entry.ws?.readyState === WebSocket.OPEN) {",
            '            try {',
            '              Promise.resolve(zhTitleCtrl?.onTargetAttached?.(id, entry.send)).catch(() => {});',
            '            } catch {}',
            '          }',
            '        }',
            '      }',
            '    }'
          ].join('\n')
        );
      } else {
        missingBridgeAnchors.push('sync hot-reload');
      }
    }

    if (missingBridgeAnchors.length > 0) {
      warnLog(
        `[Warn] applyZhTitleBridge: missing anchors (${missingBridgeAnchors.join(', ')}); skipping zhTitle bridge injection cleanly.`
      );
      return preBridgeCode;
    }

    return nextCode;
  } catch (err) {
    warnLog(`[Warn] applyZhTitleBridge failed safely: ${err?.message || err}`);
    return daemonCode;
  }
}

async function checkAndUpdate() {
  log('Starting theme patch update check...');
  try {
    // 1. 获取远程 HEAD commit hash
    const lsOut = execSync(`git ls-remote ${REPO_URL} HEAD`, { encoding: 'utf8', timeout: 15000 }).trim();
    const remoteHash = lsOut.split(/\s+/)[0];
    if (!remoteHash || remoteHash.length < 32) {
      log('Failed to parse remote commit hash from git ls-remote.');
      return;
    }

    let localHash = '';
    if (fs.existsSync(HASH_FILE)) {
      localHash = fs.readFileSync(HASH_FILE, 'utf8').trim();
    }

    log(`Remote commit: ${remoteHash.slice(0, 7)} | Local commit: ${localHash ? localHash.slice(0, 7) : 'none'}`);

    if (localHash === remoteHash) {
      log('Current version is already up to date. No action needed.');
      return;
    }

    log(`New update detected! Upgrading to ${remoteHash.slice(0, 7)}...`);
    const tempDir = path.join(os.tmpdir(), `chuanban-auto-update-${Date.now()}`);

    try {
      execSync(`git clone ${REPO_URL} "${tempDir}"`, { stdio: 'ignore', timeout: 30000 });
      execSync('git config core.autocrlf false', { cwd: tempDir, stdio: 'ignore' });
      execSync('git rm --cached -r .', { cwd: tempDir, stdio: 'ignore' });
      execSync('git reset --hard', { cwd: tempDir, stdio: 'ignore' });

      // 加固 core/daemon.mjs 防异常退出守护
      const daemonPath = path.join(tempDir, 'core', 'daemon.mjs');
      let daemonCode = fs.readFileSync(daemonPath, 'utf8');

      if (!daemonCode.includes('[Daemon Protected Exception]')) {
        daemonCode = daemonCode.replace(
          "const USER_DIR = path.join(ROOT_DIR, 'user');",
          "const USER_DIR = path.join(ROOT_DIR, 'user');\n\nprocess.on('uncaughtException', (err) => console.error('[Daemon Protected Exception]', err?.message || err));\nprocess.on('unhandledRejection', (reason) => console.error('[Daemon Protected Rejection]', reason?.message || reason));"
        );
      }
      if (!daemonCode.includes('ws.send(JSON.stringify({ id, method, params }));\n          } catch')) {
        daemonCode = daemonCode.replace(
          'ws.send(JSON.stringify({ id, method, params }));',
          'try { ws.send(JSON.stringify({ id, method, params })); } catch { clearTimeout(timer); pendingCallbacks.delete(id); resolve(null); }'
        );
      }
      if (daemonCode.includes('setInterval(sync, 2500);')) {
        daemonCode = daemonCode.replace(
          'setInterval(sync, 2500);',
          'setInterval(() => { sync().catch(err => console.error("[Daemon Sync Exception]", err?.message || err)); }, 2500);'
        );
      }

      if (!daemonCode.includes("loc.href === 'about:blank'") && !daemonCode.includes('isSkippedNonHost(')) {
        daemonCode = daemonCode.replace(
          "    return 'non_host';",
          [
            '    if (',
            '      !loc ||',
            "      loc.href === 'about:blank' ||",
            '      !document.body ||',
            '      (document.body.children.length === 0 && (!document.head || document.head.children.length === 0))',
            '    ) {',
            "      return 'pending';",
            '    }',
            "    return 'non_host';"
          ].join('\n')
        );
      }
      if (!daemonCode.includes('skipped.skippedAt || 0')) {
        daemonCode = daemonCode.replace(
          'if (skipped && (!isAllowedOrigin(t.url) || getTargetOriginKey(t.url) !== skipped.origin)) {',
          'if (skipped && (!isAllowedOrigin(t.url) || getTargetOriginKey(t.url) !== skipped.origin || nowMs - (skipped.skippedAt || 0) > 8000)) {'
        );
      }

      const preZhBridgeCode = daemonCode;
      const upstreamHasNativeZh = detectUpstreamNativeZhTitle(tempDir, preZhBridgeCode);
      if (upstreamHasNativeZh) {
        log('[Info] Upstream natively supports zhTitle conversation naming; skipping custom zhTitle bridge merge.');
      } else {
        daemonCode = applyZhTitleBridge(daemonCode, log);
        const missingMarkers = verifyZhTitleBridgeMarkers(daemonCode);
        if (missingMarkers.length > 0) {
          log(
            `[ERROR] zhTitle safe-merge incomplete (missing: ${missingMarkers.join(', ')}); aborting upgrade to preserve existing zhTitle conversation naming.`
          );
          return;
        }
      }
      fs.writeFileSync(daemonPath, daemonCode, 'utf8');

      const syntaxCheck = spawnSync(process.execPath, ['--check', daemonPath], {
        encoding: 'utf8',
        windowsHide: true
      });
      if (syntaxCheck.status !== 0) {
        log(
          `[ERROR] Merged core/daemon.mjs failed syntax check (${(syntaxCheck.stderr || '').trim()}); aborting upgrade to preserve existing working install.`
        );
        return;
      }

      // 重建 manifest 校验
      execSync('node install.mjs build-manifest', { cwd: tempDir, stdio: 'pipe' });

      // 执行无损安装升级（自动保留 user/ 个人配置并备份旧 core）
      const installOut = execSync('node install.mjs install', { cwd: tempDir, encoding: 'utf8' });
      if (installOut && installOut.includes('"warning"')) {
        log(`[Install notice] ${installOut.replace(/\s+/g, ' ').slice(0, 400)}`);
      }

      // 记录最新 commit hash
      fs.writeFileSync(HASH_FILE, remoteHash + '\n', 'utf8');

      // 通过 WMI 确保后台守护进程脱离会话树独立驻留
      const vbsPath = path.join(__dirname, 'AntigravityThemeDaemon.vbs');
      if (fs.existsSync(vbsPath)) {
        try {
          const psCmd = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'wscript.exe //B //NoLogo "${vbsPath}"' }`;
          execSync(`powershell.exe -NoProfile -Command "${psCmd}"`, { stdio: 'ignore' });
        } catch {}
      }

      log(`Successfully upgraded to commit ${remoteHash.slice(0, 7)}!`);
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  } catch (err) {
    log(`Update check failed: ${err.message}`);
  }
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]).toLowerCase() === fs.realpathSync(__filename).toLowerCase();
  } catch {
    return path.resolve(process.argv[1]).toLowerCase() === path.resolve(__filename).toLowerCase();
  }
})();

if (isMainModule) {
  checkAndUpdate();
}
