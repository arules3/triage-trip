import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

function getCursorUserDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor', 'User');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User');
  }
  return path.join(home, '.config', 'Cursor', 'User');
}

/**
 * Finds the workspaceStorage directory for the current working directory.
 */
function findCurrentWorkspaceDb(cwd = process.cwd()) {
  const userDir = getCursorUserDir();
  const workspaceStorageDir = path.join(userDir, 'workspaceStorage');
  if (!fs.existsSync(workspaceStorageDir)) return null;

  const entries = fs.readdirSync(workspaceStorageDir);
  const normalizedCwd = path.resolve(cwd).toLowerCase();

  for (const entry of entries) {
    const fullPath = path.join(workspaceStorageDir, entry);
    const jsonPath = path.join(fullPath, 'workspace.json');
    const dbPath = path.join(fullPath, 'state.vscdb');

    if (fs.existsSync(jsonPath) && fs.existsSync(dbPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (metadata.folder) {
          // Decode file:/// URI and normalize
          const decodedFolder = decodeURIComponent(metadata.folder)
            .replace(/^file:\/\//, '')
            .toLowerCase();

          if (normalizedCwd.includes(decodedFolder) || decodedFolder.includes(normalizedCwd)) {
            return dbPath;
          }
        }
      } catch {
        // continue search
      }
    }
  }
  return null;
}

function extractText(data) {
  if (!data) return null;
  if (typeof data.text === 'string' && data.text.trim()) return data.text.trim();
  
  // Modern Composer richText AST
  if (Array.isArray(data.richText)) {
    const text = data.richText.map(node => node.text || '').join(' ').trim();
    if (text) return text;
  }
  
  // Composer conversation arrays
  if (Array.isArray(data.conversation)) {
    const lastUserTurn = [...data.conversation].reverse().find(t => t.type === 'user');
    if (lastUserTurn?.text) return lastUserTurn.text.trim();
  }

  return null;
}

export function getRecentCursorPrompts(limit = 10) {
  const dbPath = findCurrentWorkspaceDb();
  const userDir = getCursorUserDir();
  const globalDbPath = path.join(userDir, 'globalStorage', 'state.vscdb');

  let prompts = [];
  if (dbPath) {
    prompts = queryDb(dbPath, limit);
  }

  // Fallback to global storage if nothing found in workspace
  if (prompts.length === 0 && fs.existsSync(globalDbPath)) {
    prompts = queryDb(globalDbPath, limit);
  }

  return prompts.slice(0, limit);
}

function queryDb(dbPath, limit) {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const prompts = [];

    // 1. Check cursorDiskKV table
    const hasDiskKV = db.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'").get().count > 0;
    if (hasDiskKV) {
      const rows = db.prepare(`
        SELECT key, value FROM cursorDiskKV 
        WHERE key LIKE 'composerData:%' OR key LIKE 'bubbleId:%' 
        ORDER BY rowid DESC LIMIT 50
      `).all();

      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.value);
          const promptText = extractText(parsed);
          if (promptText) {
            prompts.push({
              prompt: promptText,
              timestamp: parsed.createdAt || null,
              model: parsed.modelType || parsed.modelConfig?.modelName || 'unknown'
            });
          }
        } catch {
          // ignore non-json blobs
        }
      }
    }

    // 2. Fallback to ItemTable
    const hasItemTable = db.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='ItemTable'").get().count > 0;
    if (hasItemTable && prompts.length === 0) {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get();
      if (row?.value) {
        const data = JSON.parse(row.value);
        if (Array.isArray(data.allComposers)) {
          data.allComposers.slice(-limit).forEach(c => {
            const promptText = extractText(c) || c.name;
            if (promptText) {
              prompts.push({
                prompt: promptText,
                timestamp: c.createdAt || null
              });
            }
          });
        }
      }
    }

    db.close();
    return prompts;
  } catch {
    return [];
  }
}