// src/cursor.js
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

export function findCurrentWorkspaceDb(cwd = process.cwd()) {
    const userDir = getCursorUserDir();
    const workspaceStorageDir = path.join(userDir, 'workspaceStorage');
    if (!fs.existsSync(workspaceStorageDir)) return null;

    try {
        const entries = fs.readdirSync(workspaceStorageDir);
        let bestMatch = null;
        const normalizedCwd = path.resolve(cwd).toLowerCase();

        for (const entry of entries) {
            const fullPath = path.join(workspaceStorageDir, entry);
            const jsonPath = path.join(fullPath, 'workspace.json');
            const dbPath = path.join(fullPath, 'state.vscdb');

            if (fs.existsSync(jsonPath) && fs.existsSync(dbPath)) {
                try {
                    const metadata = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                    if (metadata.folder) {
                        let folderPath = decodeURIComponent(metadata.folder);
                        if (folderPath.startsWith('file://')) {
                            folderPath = folderPath.replace('file://', '');
                        }
                        const normalizedFolder = path.resolve(folderPath).toLowerCase();

                        // Exact folder match takes highest priority
                        if (normalizedFolder === normalizedCwd) {
                            return dbPath;
                        }
                    }
                } catch { }
            }
        }
    } catch { }
    return null;
}

// Inside src/cursor.js - update getRecentCursorPrompts:

export function getRecentCursorPrompts(limit = 5) {
    const userDir = getCursorUserDir();
    const workspaceDbPath = findCurrentWorkspaceDb();
    const globalDbPath = path.join(userDir, 'globalStorage', 'state.vscdb');

    if (!fs.existsSync(globalDbPath)) return [];

    let targetComposerIds = [];
    if (workspaceDbPath && fs.existsSync(workspaceDbPath)) {
        try {
            const wsDb = new Database(workspaceDbPath, { readonly: true, fileMustExist: true });
            const row = wsDb.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get();
            if (row?.value) {
                const parsed = JSON.parse(row.value);
                if (Array.isArray(parsed.selectedComposerIds)) {
                    targetComposerIds.push(...parsed.selectedComposerIds);
                }
                if (Array.isArray(parsed.lastFocusedComposerIds)) {
                    targetComposerIds.push(...parsed.lastFocusedComposerIds);
                }
            }
            wsDb.close();
        } catch { }
    }

    targetComposerIds = [...new Set(targetComposerIds)];

    try {
        const gDb = new Database(globalDbPath, { readonly: true, fileMustExist: true });
        let rows = [];

        if (targetComposerIds.length > 0) {
            const placeholders = targetComposerIds.map(() => 'key LIKE ?').join(' OR ');
            const params = targetComposerIds.map((id) => `bubbleId:${id}:%`);
            rows = gDb
                .prepare(`SELECT key, value FROM cursorDiskKV WHERE ${placeholders}`)
                .all(...params);
        }

        if (rows.length === 0) {
            rows = gDb
                .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' ORDER BY rowid DESC LIMIT 200")
                .all();
        }

        const prompts = [];

        for (const row of rows) {
            try {
                const data = JSON.parse(row.value);
                let text = null;

                if (typeof data.text === 'string') {
                    text = data.text;
                } else if (Array.isArray(data.richText)) {
                    text = data.richText.map((n) => n.text || '').join(' ');
                }

                if (text) {
                    text = text.trim();

                    const isAssistant =
                        data.type === 2 ||
                        data.type === 'ai' ||
                        data.type === 'assistant' ||
                        data.bubbleType === 'ai' ||
                        data.bubbleType === 'assistant' ||
                        text.startsWith('#') ||
                        text.startsWith('```');

                    const isUser =
                        data.type === 1 ||
                        data.type === 'user' ||
                        data.bubbleType === 'user';

                    // Only keep user prompts, skip assistant replies & system notifications
                    if (isUser && !text.startsWith('<timestamp>') && !text.startsWith('<system_') && text.length > 2) {
                        // Normalize timestamp to integer epoch
                        const ts = data.createdAt || data.timestamp || data.clientTimestamp || 0;
                        const timeNum = typeof ts === 'string' ? new Date(ts).getTime() : Number(ts);

                        prompts.push({
                            prompt: text,
                            timestamp: timeNum || 0,
                        });
                    } else if (!isAssistant && !isUser && text.length > 2 && text.length < 500 && !text.startsWith('<timestamp>') && !text.startsWith('<system_')) {
                        const ts = data.createdAt || data.timestamp || data.clientTimestamp || 0;
                        const timeNum = typeof ts === 'string' ? new Date(ts).getTime() : Number(ts);

                        prompts.push({
                            prompt: text,
                            timestamp: timeNum || 0,
                        });
                    }
                }
            } catch { }
        }

        gDb.close();

        // 1. Sort strictly descending by timestamp (newest first)
        prompts.sort((a, b) => b.timestamp - a.timestamp);

        // 2. Deduplicate keeping only the latest occurrence
        const uniquePrompts = [];
        for (const item of prompts) {
            if (!uniquePrompts.some((p) => p.prompt === item.prompt)) {
                uniquePrompts.push({
                    prompt: item.prompt,
                    timestamp: item.timestamp ? new Date(item.timestamp).toISOString() : null,
                });
            }
        }

        return uniquePrompts.slice(0, limit);
    } catch (err) {
        return [];
    }
}

