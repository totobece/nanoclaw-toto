/**
 * Railway Runner for NanoClaw
 * Spawns the agent-runner as a child Node.js process instead of a Docker
 * container. Used when IS_RAILWAY is true (no Docker-in-Docker on Railway).
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { ContainerInput, ContainerOutput } from './container-runner.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import { RegisteredGroup } from './types.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/** Prepare workspace directories (mirrors container-runner's volume setup). */
function prepareWorkspace(
  group: RegisteredGroup,
  isMain: boolean,
): {
  groupDir: string;
  globalDir: string | undefined;
  extraDir: string | undefined;
  ipcDir: string;
  claudeDir: string;
} {
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Sync CLAUDE.md template from image (/app/groups) to volume (/data/groups)
  const templateGroupsDir = path.join(process.cwd(), 'groups');
  for (const folder of [group.folder, 'global']) {
    const targetDir = path.join(GROUPS_DIR, folder);
    const targetMd = path.join(targetDir, 'CLAUDE.md');
    const templateMd = path.join(templateGroupsDir, folder, 'CLAUDE.md');
    if (!fs.existsSync(targetMd) && fs.existsSync(templateMd)) {
      fs.mkdirSync(targetDir, { recursive: true });
      let content = fs.readFileSync(templateMd, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(targetMd, content);
      logger.info({ folder, targetMd }, 'Synced CLAUDE.md template to volume');
    }
  }

  // Global memory (read-only for non-main groups)
  let globalDir: string | undefined;
  if (!isMain) {
    const gd = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(gd)) globalDir = gd;
  }

  // Per-group Claude sessions dir (isolated .claude/)
  const claudeDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync container skills into the claude dir
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(claudeDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      fs.cpSync(srcDir, path.join(skillsDst, skillDir), { recursive: true });
    }
  }

  // IPC directory
  const ipcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });

  const extraBase = path.join(groupDir, 'extra');
  const extraDir = fs.existsSync(extraBase) ? extraBase : undefined;

  return { groupDir, globalDir, extraDir, ipcDir, claudeDir };
}

export async function runRailwayAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const { groupDir, globalDir, extraDir, ipcDir, claudeDir } =
    prepareWorkspace(group, input.isMain);

  const agentRunnerPath =
    process.env.AGENT_RUNNER_PATH ||
    path.join(process.cwd(), 'container', 'agent-runner', 'dist', 'index.js');

  const processName = `railway-${group.folder}-${Date.now()}`;

  logger.info(
    { group: group.name, processName, agentRunnerPath, isMain: input.isMain },
    'Spawning Railway agent process',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Third-party API keys passed directly to the agent (not via credential proxy)
  const thirdPartyKeys = readEnvFile(['NOTION_API_KEY']);

  return new Promise((resolve) => {
    const child = spawn('node', [agentRunnerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: groupDir,
      env: {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        NODE_PATH: process.env.NODE_PATH || '',
        TZ: TIMEZONE,
        HOME: claudeDir.replace(/\/.claude$/, ''),
        NANOCLAW_WORKSPACE_GROUP: groupDir,
        NANOCLAW_WORKSPACE_GLOBAL: globalDir || '',
        NANOCLAW_WORKSPACE_EXTRA: extraDir || '',
        NANOCLAW_IPC_DIR: ipcDir,
        NANOCLAW_IPC_INPUT: path.join(ipcDir, 'input'),
        LOG_LEVEL: process.env.LOG_LEVEL || '',
        NODE_ENV: process.env.NODE_ENV || '',
        RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT || '',
        AGENT_BROWSER_EXECUTABLE_PATH:
          process.env.AGENT_BROWSER_EXECUTABLE_PATH || '',
        PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:
          process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '',
        // Anthropic auth via credential proxy (agent never sees real keys)
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${CREDENTIAL_PROXY_PORT}`,
        ANTHROPIC_API_KEY: 'proxy-injected',
        // Third-party keys passed directly
        ...(thirdPartyKeys.NOTION_API_KEY && {
          NOTION_API_KEY: thirdPartyKeys.NOTION_API_KEY,
        }),
      },
    });

    onProcess(child, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Write input JSON to stdin
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();

    // Streaming output parsing (same protocol as container-runner)
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let timedOut = false;
    let hadStreamingOutput = false;

    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Railway agent timeout, sending SIGTERM',
      );
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 15000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    child.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;
          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);
          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) newSessionId = parsed.newSessionId;
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn({ group: group.name, err }, 'Failed to parse output chunk');
          }
        }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      for (const line of chunk.trim().split('\n')) {
        if (line) logger.debug({ process: group.folder }, line);
      }
      if (!stderrTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
        if (chunk.length > remaining) {
          stderr += chunk.slice(0, remaining);
          stderrTruncated = true;
        } else {
          stderr += chunk;
        }
      }
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        if (hadStreamingOutput) {
          outputChain.then(() =>
            resolve({ status: 'success', result: null, newSessionId }),
          );
          return;
        }
        resolve({
          status: 'error',
          result: null,
          error: `Railway agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      // Write diagnostic log
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `railway-${timestamp}.log`);
      const isVerbose = ['debug', 'trace'].includes(process.env.LOG_LEVEL || '');
      const logLines = [
        `=== Railway Agent Run ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name} | Duration: ${duration}ms | Exit: ${code}`,
      ];
      if (isVerbose || code !== 0) {
        logLines.push(
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      }
      fs.writeFileSync(logFile, logLines.join('\n'));

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, logFile },
          'Railway agent exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Railway agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Railway agent completed',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Non-streaming fallback: parse last output marker
      try {
        const startIdx = stdout.lastIndexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER, startIdx);
        const jsonStr =
          startIdx !== -1 && endIdx > startIdx
            ? stdout.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim()
            : stdout.trim().split('\n').pop() || '';
        const output: ContainerOutput = JSON.parse(jsonStr);
        resolve(output);
      } catch (err) {
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    child.on('error', (err: Error) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, processName, err }, 'Railway agent spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Railway agent spawn error: ${err.message}`,
      });
    });
  });
}
