const {
  Plugin,
  Notice,
  PluginSettingTab,
  Setting,
  requestUrl,
  TFile,
  TFolder,
} = require("obsidian");

const DEFAULT_SETTINGS = {
  owner: "antonpixel9",
  repository: "obsidian_vault",
  branch: "main",
  token: "",
  autoSync: true,
  autoUpdate: true,
  intervalSeconds: 30,
  lastRemoteHead: "",
  remoteShas: {},
  pendingDeletes: {},
  initialUploadComplete: false,
};

module.exports = class ChatGPTGitHubBridge extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.remoteShas = this.settings.remoteShas || {};
    this.settings.pendingDeletes = this.settings.pendingDeletes || {};
    this.pendingPushes = new Map();
    this.localQueue = Promise.resolve();
    this.localOperationsPending = 0;
    this.applyingRemote = false;
    this.syncRunning = false;
    this.startupReady = false;
    this.lastSaveNoticeAt = 0;
    this.lastFullScanAt = 0;

    this.addSettingTab(new BridgeSettingTab(this.app, this));

    this.addCommand({ id: "check-bridge", name: "Проверить работу плагина", callback: () => new Notice("ChatGPT GitHub Bridge работает") });
    this.addCommand({ id: "check-github", name: "Проверить подключение к GitHub", callback: () => this.checkGitHub() });
    this.addCommand({ id: "sync-now", name: "Синхронизировать сейчас", callback: () => this.backgroundSync(true) });
    this.addCommand({ id: "verify-all-files", name: "Проверить все файлы GitHub и скачать недостающие", callback: () => this.verifyAllFiles() });
    this.addCommand({ id: "push-current-note", name: "Отправить открытую заметку и фотографии", callback: () => this.pushCurrentNote() });
    this.addCommand({ id: "pull-current-note", name: "Получить открытую заметку из GitHub", callback: () => this.pullCurrentNote() });
    this.addCommand({ id: "update-plugin", name: "Проверить обновление плагина", callback: () => this.checkForPluginUpdate(true) });
    this.addCommand({ id: "install-keep-notes", name: "Установить или обновить Keep Notes", callback: () => this.checkForCompanionPlugin(true) });

    this.addRibbonIcon("refresh-cw", "Синхронизировать сейчас", () => this.backgroundSync(true));

    this.registerEvent(this.app.vault.on("modify", (file) => this.onLocalChange(file)));
    this.registerEvent(this.app.vault.on("create", (file) => this.onLocalChange(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onLocalDelete(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onLocalRename(file, oldPath)));

    const intervalMs = Math.max(15, Number(this.settings.intervalSeconds) || 30) * 1000;
    this.registerInterval(window.setInterval(() => this.backgroundSync(false), intervalMs));

    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(async () => {
        await this.backgroundSync(false);
        // First-time vaults must never upload automatically.
        // Use the explicit download command before enabling sync.
        this.startupReady = true;
      }, 2500);
    });
  }

  onunload() {
    for (const timeout of this.pendingPushes.values()) window.clearTimeout(timeout);
    this.pendingPushes.clear();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  headers() {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.settings.token.trim()}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  apiUrl(path) {
    const owner = encodeURIComponent(this.settings.owner);
    const repository = encodeURIComponent(this.settings.repository);
    return `https://api.github.com/repos/${owner}/${repository}${path}`;
  }

  encodedPath(path) {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  shouldIgnorePath(path) {
    return path.split("/").pop() === ".gitkeep" || path === ".gitignore" || path.startsWith(".github/") || path.startsWith(".obsidian/") || path.startsWith(".trash/");
  }

  requireSettings(showNotice = true) {
    if (!this.settings.token.trim()) {
      if (showNotice) new Notice("Добавьте токен GitHub в настройках плагина");
      return false;
    }
    return true;
  }

  activeFile() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("Сначала откройте заметку");
      return null;
    }
    return file;
  }

  bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  base64ToBytes(value) {
    const binary = atob(value.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  base64ToText(value) {
    return new TextDecoder().decode(this.base64ToBytes(value));
  }

  async gitBlobSha(bytes) {
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const joined = new Uint8Array(header.length + bytes.length);
    joined.set(header, 0);
    joined.set(bytes, header.length);
    const digest = await crypto.subtle.digest("SHA-1", joined);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async getRemoteFile(path, ref = this.settings.branch) {
    return requestUrl({
      url: this.apiUrl(`/contents/${this.encodedPath(path)}?ref=${encodeURIComponent(ref)}`),
      method: "GET",
      headers: this.headers(),
      throw: false,
    });
  }

  async getRemoteHead() {
    const response = await requestUrl({
      url: this.apiUrl(`/git/ref/heads/${encodeURIComponent(this.settings.branch)}`),
      method: "GET",
      headers: this.headers(),
      throw: false,
    });
    if (response.status !== 200 || !response.json.object) return null;
    return response.json.object.sha;
  }

  async checkGitHub() {
    if (!this.requireSettings()) return;
    try {
      const response = await requestUrl({ url: this.apiUrl(""), method: "GET", headers: this.headers(), throw: false });
      if (response.status === 200) {
        new Notice(`GitHub подключён: ${this.settings.owner}/${this.settings.repository}, ветка ${response.json.default_branch || this.settings.branch}`);
      } else if (response.status === 401) {
        new Notice("GitHub отклонил токен. Проверьте токен и его срок действия");
      } else if (response.status === 404) {
        new Notice("Репозиторий не найден или токен не имеет к нему доступа");
      } else {
        new Notice(`Ошибка GitHub: ${response.status}`);
      }
    } catch (error) {
      console.error("ChatGPT GitHub Bridge:", error);
      new Notice("Не удалось подключиться к GitHub");
    }
  }

  onLocalChange(file) {
    if (!this.startupReady || !this.settings.autoSync || this.applyingRemote || !(file instanceof TFile) || this.shouldIgnorePath(file.path)) return;

    if (this.settings.pendingDeletes[file.path]) {
      delete this.settings.pendingDeletes[file.path];
      this.saveSettings().catch((error) => console.error("ChatGPT GitHub Bridge recreate:", error));
    }

    const oldTimeout = this.pendingPushes.get(file.path);
    if (oldTimeout) window.clearTimeout(oldTimeout);

    const timeout = window.setTimeout(async () => {
      this.pendingPushes.delete(file.path);
      const currentFile = this.app.vault.getAbstractFileByPath(file.path);
      if (!(currentFile instanceof TFile)) return;
      try {
        await this.pushFileSafely(currentFile);
        const now = Date.now();
        if (now - this.lastSaveNoticeAt >= 60000) {
          this.lastSaveNoticeAt = now;
          new Notice(`Сохранено в GitHub: ${currentFile.name}`, 1200);
        }
      } catch (error) {
        console.error("ChatGPT GitHub Bridge auto push:", error);
        new Notice(`Не удалось автоматически отправить: ${file.name}`);
      }
    }, 15000);

    this.pendingPushes.set(file.path, timeout);
  }

  queueLocalOperation(label, operation) {
    this.localOperationsPending++;
    const run = async () => {
      try {
        await operation();
      } catch (error) {
        console.error(`ChatGPT GitHub Bridge ${label}:`, error);
        new Notice("Не удалось передать удаление или перенос в GitHub. Плагин повторит попытку автоматически", 8000);
      } finally {
        this.localOperationsPending--;
      }
    };
    this.localQueue = this.localQueue.then(run, run);
    return this.localQueue;
  }

  cancelPendingPush(path) {
    const timeout = this.pendingPushes.get(path);
    if (timeout) window.clearTimeout(timeout);
    this.pendingPushes.delete(path);
  }

  async rememberDeletes(paths) {
    for (const path of paths) {
      if (!this.shouldIgnorePath(path)) this.settings.pendingDeletes[path] = Date.now();
    }
    await this.saveSettings();
  }

  onLocalDelete(file) {
    if (!this.startupReady || !this.settings.autoSync || this.applyingRemote || !(file instanceof TFile || file instanceof TFolder)) return;

    const paths = (file instanceof TFile
      ? [file.path]
      : Object.keys(this.settings.remoteShas).filter((path) => path.startsWith(`${file.path}/`)))
      .filter((path) => !this.shouldIgnorePath(path));
    if (!paths.length) return;
    for (const path of paths) this.cancelPendingPush(path);

    this.rememberDeletes(paths).then(() => this.queueLocalOperation("delete", async () => {
      for (const path of paths) await this.deleteRemotePath(path);
    }));
  }

  onLocalRename(file, oldPath) {
    if (!this.startupReady || !this.settings.autoSync || this.applyingRemote || !(file instanceof TFile || file instanceof TFolder) || file.path === oldPath) return;

    const moves = [];
    if (file instanceof TFile) {
      moves.push({ oldPath, file });
    } else {
      const prefix = `${file.path}/`;
      const oldPrefix = `${oldPath}/`;
      const movedFiles = this.app.vault.getFiles().filter((item) => item.path.startsWith(prefix));
      const currentOldPaths = new Set();
      for (const movedFile of movedFiles) {
        const movedOldPath = `${oldPrefix}${movedFile.path.slice(prefix.length)}`;
        currentOldPaths.add(movedOldPath);
        moves.push({ oldPath: movedOldPath, file: movedFile });
      }
      for (const remotePath of Object.keys(this.settings.remoteShas)) {
        if (remotePath.startsWith(oldPrefix) && !currentOldPaths.has(remotePath)) moves.push({ oldPath: remotePath, file: null });
      }
    }

    const oldPaths = moves.map((move) => move.oldPath).filter((path) => !this.shouldIgnorePath(path));
    for (const move of moves) {
      this.cancelPendingPush(move.oldPath);
      if (move.file) this.cancelPendingPush(move.file.path);
    }

    this.rememberDeletes(oldPaths).then(() => this.queueLocalOperation("rename", async () => {
      for (const move of moves) {
        const current = move.file && this.app.vault.getAbstractFileByPath(move.file.path);
        if (current instanceof TFile && !this.shouldIgnorePath(current.path)) await this.pushFileSafely(current);
        if (!this.shouldIgnorePath(move.oldPath)) await this.deleteRemotePath(move.oldPath);
      }
    }));
  }

  async deleteRemotePath(path) {
    if (!this.requireSettings(false)) return false;

    const recreated = this.app.vault.getAbstractFileByPath(path);
    if (recreated instanceof TFile) {
      delete this.settings.pendingDeletes[path];
      await this.saveSettings();
      return false;
    }

    const current = await this.getRemoteFile(path);
    if (current.status === 404) {
      delete this.settings.remoteShas[path];
      delete this.settings.pendingDeletes[path];
      await this.saveSettings();
      return false;
    }
    if (current.status !== 200 || !current.json.sha) throw new Error(`Удаление ${path}: ${current.status}`);

    const response = await requestUrl({
      url: this.apiUrl(`/contents/${this.encodedPath(path)}`),
      method: "DELETE",
      headers: Object.assign({}, this.headers(), { "Content-Type": "application/json" }),
      body: JSON.stringify({
        message: `Obsidian: удалить ${path}`,
        sha: current.json.sha,
        branch: this.settings.branch,
      }),
      throw: false,
    });
    if (response.status !== 200) throw new Error(`Удаление ${path}: ${response.status}`);

    delete this.settings.remoteShas[path];
    delete this.settings.pendingDeletes[path];
    await this.saveSettings();
    return true;
  }

  async pushFileSafely(file) {
    if (!this.requireSettings(false)) return;

    const bytes = new Uint8Array(await this.app.vault.readBinary(file));
    const localSha = await this.gitBlobSha(bytes);
    const current = await this.getRemoteFile(file.path);

    if (current.status === 200 && current.json.sha === localSha) {
      this.settings.remoteShas[file.path] = localSha;
      await this.saveSettings();
      return;
    }
    if (current.status !== 200 && current.status !== 404) {
      throw new Error(`Проверка ${file.path}: ${current.status}`);
    }

    const knownSha = this.settings.remoteShas[file.path];
    if (current.status === 200 && knownSha && current.json.sha !== knownSha) {
      new Notice(`Есть изменения ChatGPT: ${file.name}. Они будут получены автоматически`);
      await this.pullRemoteFile(file.path, current.json.sha, true);
      return;
    }

    const payload = {
      message: `Obsidian: обновить ${file.path}`,
      content: this.bytesToBase64(bytes),
      branch: this.settings.branch,
    };
    if (current.status === 200 && current.json.sha) payload.sha = current.json.sha;

    const response = await requestUrl({
      url: this.apiUrl(`/contents/${this.encodedPath(file.path)}`),
      method: "PUT",
      headers: Object.assign({}, this.headers(), { "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
      throw: false,
    });

    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`Отправка ${file.path}: ${response.status}`);
    }

    const newSha = response.json && response.json.content && response.json.content.sha;
    this.settings.remoteShas[file.path] = newSha || localSha;
    await this.saveSettings();
  }

  async pushCurrentNote() {
    if (!this.requireSettings()) return;
    const file = this.activeFile();
    if (!file) return;

    try {
      await this.pushFileSafely(file);
      const cache = this.app.metadataCache.getFileCache(file);
      const attachments = [];
      for (const embed of (cache && cache.embeds) || []) {
        const attachment = this.app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
        if (attachment instanceof TFile && !attachments.some((item) => item.path === attachment.path)) attachments.push(attachment);
      }
      for (const attachment of attachments) await this.pushFileSafely(attachment);
      new Notice(attachments.length ? `Заметка и вложения отправлены: ${attachments.length + 1} файлов` : "Заметка отправлена в GitHub");
    } catch (error) {
      console.error("ChatGPT GitHub Bridge push:", error);
      new Notice("Не удалось отправить заметку или одно из вложений");
    }
  }

  async ensureFolder(path) {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try { await this.app.vault.createFolder(current); } catch (_) {}
      }
    }
  }

  async uniqueConflictPath(path) {
    const dot = path.lastIndexOf(".");
    const base = dot > 0 ? path.slice(0, dot) : path;
    const ext = dot > 0 ? path.slice(dot) : "";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `${base}.локальная-копия-${stamp}${ext}`;
  }

  async fetchBlob(sha) {
    const response = await requestUrl({
      url: this.apiUrl(`/git/blobs/${sha}`),
      method: "GET",
      headers: this.headers(),
      throw: false,
    });
    if (response.status !== 200 || typeof response.json.content !== "string") throw new Error(`Blob ${sha}: ${response.status}`);
    return this.base64ToBytes(response.json.content);
  }

  async pullRemoteFile(path, remoteSha, preserveConflict) {
    const bytes = remoteSha === "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391" ? new Uint8Array(0) : await this.fetchBlob(remoteSha);
    let local = this.app.vault.getAbstractFileByPath(path);

    this.applyingRemote = true;
    try {
      if (local instanceof TFile) {
        if (preserveConflict) {
          const localBytes = new Uint8Array(await this.app.vault.readBinary(local));
          const localSha = await this.gitBlobSha(localBytes);
          const knownSha = this.settings.remoteShas[path];
          if (knownSha && localSha !== knownSha && localSha !== remoteSha) {
            const backupPath = await this.uniqueConflictPath(path);
            await this.ensureFolder(backupPath);
            await this.app.vault.createBinary(backupPath, localBytes.buffer);
            new Notice(`Сохранена локальная копия конфликта: ${local.name}`);
          }
        }
        await this.app.vault.modifyBinary(local, bytes.buffer);
      } else if (!local) {
        await this.ensureFolder(path);
        await this.app.vault.createBinary(path, bytes.buffer);
      }
    } finally {
      this.applyingRemote = false;
    }

    this.settings.remoteShas[path] = remoteSha;
  }

  async pullCurrentNote() {
    if (!this.requireSettings()) return;
    const file = this.activeFile();
    if (!file) return;

    try {
      const response = await this.getRemoteFile(file.path);
      if (response.status === 404) {
        new Notice("Этой заметки пока нет в GitHub");
        return;
      }
      if (response.status !== 200 || !response.json.sha) {
        new Notice(`Ошибка получения: ${response.status}`);
        return;
      }
      await this.pullRemoteFile(file.path, response.json.sha, true);
      await this.saveSettings();
      new Notice("Заметка получена из GitHub");
    } catch (error) {
      console.error("ChatGPT GitHub Bridge pull:", error);
      new Notice("Не удалось получить заметку");
    }
  }

  async syncRemoteChanges(head, showNotice) {
    const response = await requestUrl({
      url: this.apiUrl(`/git/trees/${encodeURIComponent(head)}?recursive=1`),
      method: "GET",
      headers: this.headers(),
      throw: false,
    });
    if (response.status !== 200 || !Array.isArray(response.json.tree)) throw new Error(`Tree: ${response.status}`);

    if (response.json.truncated) throw new Error("GitHub вернул неполный список файлов");
    let received = 0;
    const failures = [];
    const items = response.json.tree.slice().sort((a, b) => {
      const rank = (item) => item.path.startsWith("Публикации/") ? 0 : item.path.endsWith(".md") ? 1 : 2;
      return rank(a) - rank(b);
    });
    for (const item of items) {
      if (item.type !== "blob" || this.shouldIgnorePath(item.path)) continue;

      try {
      if (this.settings.pendingDeletes[item.path]) {
        await this.deleteRemotePath(item.path);
        received++;
        continue;
      }

      const local = this.app.vault.getAbstractFileByPath(item.path);
      if (!(local instanceof TFile)) {
        await this.pullRemoteFile(item.path, item.sha, false);
        received++;
        continue;
      }

      const localBytes = new Uint8Array(await this.app.vault.readBinary(local));
      const localSha = await this.gitBlobSha(localBytes);
      const knownSha = this.settings.remoteShas[item.path];

      if (localSha === item.sha) {
        this.settings.remoteShas[item.path] = item.sha;
      } else if (knownSha && localSha === knownSha && item.sha !== knownSha) {
        await this.pullRemoteFile(item.path, item.sha, false);
        received++;
      } else if (knownSha && item.sha === knownSha && localSha !== knownSha) {
        this.onLocalChange(local);
      } else if (knownSha && item.sha !== knownSha && localSha !== knownSha) {
        await this.pullRemoteFile(item.path, item.sha, true);
        received++;
      } else if (!knownSha && item.sha === "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391" && localBytes.length) {
        // The empty note may have reached GitHub while the user was typing.
        // Preserve the new local text as the original note, not as a conflict copy.
        this.settings.remoteShas[item.path] = item.sha;
        await this.pushFileSafely(local);
        received++;
      } else {
        const backupPath = await this.uniqueConflictPath(item.path);
        await this.ensureFolder(backupPath);
        await this.app.vault.createBinary(backupPath, localBytes.buffer);
        await this.pullRemoteFile(item.path, item.sha, false);
        received++;
        new Notice(`Изменения объединены с сохранением локальной копии: ${local.name}`);
      }
      } catch (error) {
        failures.push(item.path);
        console.error("ChatGPT GitHub Bridge file:", item.path, error);
      }
    }

    const remotePaths = new Set(
      response.json.tree
        .filter((item) => item.type === "blob" && !this.shouldIgnorePath(item.path) && !this.settings.pendingDeletes[item.path])
        .map((item) => item.path)
    );
    received += await this.deleteRemoteMissingFiles(remotePaths);
    if (this.settings.initialUploadComplete) received += await this.uploadLocalMissingFiles(remotePaths);

    if (!failures.length) this.settings.lastRemoteHead = head;
    await this.saveSettings();
    if (failures.length && (showNotice || this.lastSyncFailure !== failures[0])) {
      new Notice(`Не удалось скачать ${failures.length} файлов. Первый: ${failures[0]}. Остальные заметки загружены; повторная попытка автоматически.`, 10000);
    }
    this.lastSyncFailure = failures[0] || "";
    if (showNotice) new Notice(received ? `Получено изменений: ${received}` : "Синхронизация завершена");
  }

  async deleteRemoteMissingFiles(remotePaths) {
    let deleted = 0;
    for (const [path, knownSha] of Object.entries(this.settings.remoteShas)) {
      if (this.shouldIgnorePath(path) || remotePaths.has(path)) continue;

      const local = this.app.vault.getAbstractFileByPath(path);
      if (local instanceof TFile) {
        const localBytes = new Uint8Array(await this.app.vault.readBinary(local));
        const localSha = await this.gitBlobSha(localBytes);

        if (knownSha && localSha !== knownSha) {
          const backupPath = await this.uniqueConflictPath(path);
          await this.ensureFolder(backupPath);
          await this.app.vault.createBinary(backupPath, localBytes.buffer);
          new Notice(`Перед удалением сохранена локальная копия: ${local.name}`);
        }

        this.applyingRemote = true;
        try {
          await this.app.vault.delete(local, true);
        } finally {
          this.applyingRemote = false;
        }
        deleted++;
      }

      delete this.settings.remoteShas[path];
    }
    return deleted;
  }

  async uploadLocalMissingFiles(remotePaths) {
    let uploaded = 0;
    for (const file of this.app.vault.getFiles()) {
      if (this.shouldIgnorePath(file.path) || remotePaths.has(file.path) || this.settings.pendingDeletes[file.path]) continue;

      // A remembered SHA means GitHub intentionally deleted this path. The
      // deletion pass above decides whether to remove it or preserve a conflict.
      if (this.settings.remoteShas[file.path]) continue;

      await this.pushFileSafely(file);
      remotePaths.add(file.path);
      uploaded++;
    }
    return uploaded;
  }

  async checkForPluginUpdate(showNotice) {
    if (!this.settings.autoUpdate && !showNotice) return;

    try {
      const remoteManifest = await this.getRemoteFile(".obsidian/plugins/chatgpt-github-bridge/manifest.json");
      if (remoteManifest.status !== 200 || !remoteManifest.json.content) return;

      const manifestText = this.base64ToText(remoteManifest.json.content);
      const manifest = JSON.parse(manifestText);
      if (!manifest.version || manifest.version === (this.downloadedBridgeVersion || this.manifest.version)) {
        if (showNotice) new Notice("Установлена последняя версия плагина");
        return;
      }

      const remoteMain = await this.getRemoteFile(".obsidian/plugins/chatgpt-github-bridge/main.js");
      if (remoteMain.status !== 200 || !remoteMain.json.content) throw new Error("main.js");

      const pluginDir = this.manifest.dir || ".obsidian/plugins/chatgpt-github-bridge";
      await this.app.vault.adapter.write(`${pluginDir}/main.js`, this.base64ToText(remoteMain.json.content));
      await this.app.vault.adapter.write(`${pluginDir}/manifest.json`, manifestText);
      this.downloadedBridgeVersion = manifest.version;
      new Notice(`Плагин автоматически обновлён до ${manifest.version}. Перезапустите Obsidian`, 10000);
    } catch (error) {
      console.error("ChatGPT GitHub Bridge update:", error);
      if (showNotice) new Notice("Не удалось проверить обновление плагина");
    }
  }

  // Only this explicitly requested companion is installed; data.json and other
  // plugins/configuration are never downloaded or overwritten.
  async checkForCompanionPlugin(showNotice, ref) {
    if ((!this.settings.autoUpdate && !showNotice) || !this.requireSettings(showNotice) || this.companionInstalling) return;
    this.companionInstalling = true;
    const adapter = this.app.vault.adapter;
    const dir = `${this.app.vault.configDir || '.obsidian'}/plugins/keep-notes`;
    const backup = new Map();
    let writing = false;
    try {
      const pinnedRef = ref || await this.getRemoteHead();
      if (!pinnedRef) throw new Error('Не удалось получить версию GitHub');
      const remote = await this.getRemoteFile('.obsidian/plugins/keep-notes/manifest.json', pinnedRef);
      if (remote.status === 404) return;
      if (remote.status !== 200 || !remote.json.content) throw new Error('manifest.json');
      const manifestText = this.base64ToText(remote.json.content);
      const manifest = JSON.parse(manifestText);
      if (manifest.id !== 'keep-notes' || !/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.isDesktopOnly !== false) throw new Error('Некорректный манифест Keep Notes');
      let localManifest = null;
      if (await adapter.exists(`${dir}/manifest.json`)) {
        try { localManifest = JSON.parse(await adapter.read(`${dir}/manifest.json`)); } catch (_) {}
      }
      const complete = await adapter.exists(`${dir}/main.js`) && await adapter.exists(`${dir}/styles.css`);
      if (localManifest && localManifest.version === manifest.version && complete) {
        if (showNotice) new Notice('Keep Notes уже установлен. Включите его в настройках сторонних плагинов.');
        return;
      }
      const main = await this.getRemoteFile('.obsidian/plugins/keep-notes/main.js', pinnedRef);
      const styles = await this.getRemoteFile('.obsidian/plugins/keep-notes/styles.css', pinnedRef);
      if (main.status !== 200 || !main.json.content || styles.status !== 200 || !styles.json.content) throw new Error('Не все файлы Keep Notes доступны');
      const mainText = this.base64ToText(main.json.content), cssText = this.base64ToText(styles.json.content);
      if (!mainText.includes('module.exports=KeepNotes') || !cssText.includes('.kn-root')) throw new Error('Неполный пакет Keep Notes');
      for (const name of ['main.js','styles.css','manifest.json']) {
        const path = `${dir}/${name}`;
        if (await adapter.exists(path)) backup.set(name, await adapter.read(path));
      }
      for (const path of [this.app.vault.configDir || '.obsidian', `${this.app.vault.configDir || '.obsidian'}/plugins`, dir]) {
        if (!(await adapter.exists(path))) await adapter.mkdir(path);
      }
      writing = true;
      await adapter.write(`${dir}/main.js`, mainText);
      await adapter.write(`${dir}/styles.css`, cssText);
      // Manifest is written last. An incomplete transfer cannot announce a new version.
      await adapter.write(`${dir}/manifest.json`, manifestText);
      new Notice(localManifest ? `Keep Notes обновлён до ${manifest.version}. Перезапустите Obsidian.` : 'Keep Notes установлен. Перезапустите Obsidian и включите Keep Notes в сторонних плагинах.', 12000);
    } catch (error) {
      if (writing) {
        for (const name of ['main.js','styles.css','manifest.json']) {
          try {
            if (backup.has(name)) await adapter.write(`${dir}/${name}`,backup.get(name));
            else if (await adapter.exists(`${dir}/${name}`)) await adapter.remove(`${dir}/${name}`);
          } catch (rollbackError) { console.error('Keep Notes installation rollback:', rollbackError); }
        }
      }
      console.error('Keep Notes installation:',error);
      this.companionChecked = false;
      new Notice('Не удалось установить Keep Notes. Плагин повторит попытку при следующей синхронизации.',8000);
    } finally { this.companionInstalling = false; }
  }


  async githubJson(path, method, body) {
    return requestUrl({
      url: this.apiUrl(path),
      method,
      headers: Object.assign({}, this.headers(), { "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false,
    });
  }

  async uploadWholeVault() {
    if (!this.requireSettings(false) || this.uploadRunning) return;
    this.uploadRunning = true;

    try {
      const files = this.app.vault.getFiles().filter((file) => !this.shouldIgnorePath(file.path));
      new Notice(`Начинаю первоначальную загрузку: ${files.length} файлов`, 7000);

      const headResponse = await this.githubJson(
        `/git/ref/heads/${encodeURIComponent(this.settings.branch)}`,
        "GET"
      );
      if (headResponse.status !== 200 || !headResponse.json.object) throw new Error("Не удалось получить ветку");
      const headSha = headResponse.json.object.sha;

      const commitResponse = await this.githubJson(`/git/commits/${headSha}`, "GET");
      if (commitResponse.status !== 200 || !commitResponse.json.tree) throw new Error("Не удалось получить коммит");
      const baseTreeSha = commitResponse.json.tree.sha;

      const treeResponse = await this.githubJson(
        `/git/trees/${encodeURIComponent(this.settings.branch)}?recursive=1`,
        "GET"
      );
      if (treeResponse.status !== 200 || !Array.isArray(treeResponse.json.tree)) throw new Error("Не удалось получить дерево");
      const remote = new Map(
        treeResponse.json.tree.filter((item) => item.type === "blob").map((item) => [item.path, item.sha])
      );

      const changed = [];
      for (const file of files) {
        const bytes = new Uint8Array(await this.app.vault.readBinary(file));
        if (bytes.length > 95 * 1024 * 1024) {
          new Notice(`Пропущен слишком большой файл: ${file.name}`);
          continue;
        }
        const localSha = await this.gitBlobSha(bytes);
        if (remote.get(file.path) === localSha) {
          this.settings.remoteShas[file.path] = localSha;
          continue;
        }
        changed.push({ file, bytes, localSha });
      }

      if (!changed.length) {
        this.settings.initialUploadComplete = true;
        this.settings.lastRemoteHead = headSha;
        await this.saveSettings();
        new Notice("Все файлы хранилища уже находятся в GitHub");
        return;
      }

      const entries = new Array(changed.length);
      let nextIndex = 0;
      let finished = 0;
      const worker = async () => {
        while (true) {
          const index = nextIndex++;
          if (index >= changed.length) return;
          const item = changed[index];
          const blobResponse = await this.githubJson("/git/blobs", "POST", {
            content: this.bytesToBase64(item.bytes),
            encoding: "base64",
          });
          if (blobResponse.status !== 201 || !blobResponse.json.sha) {
            throw new Error(`Не удалось загрузить ${item.file.path}: ${blobResponse.status}`);
          }
          entries[index] = {
            path: item.file.path,
            mode: "100644",
            type: "blob",
            sha: blobResponse.json.sha,
          };
          this.settings.remoteShas[item.file.path] = blobResponse.json.sha;
          finished++;
          if (finished % 50 === 0) {
            new Notice(`Загружено ${finished} из ${changed.length} файлов`, 4000);
          }
        }
      };

      await Promise.all([worker(), worker(), worker(), worker()]);

      const newTree = await this.githubJson("/git/trees", "POST", {
        base_tree: baseTreeSha,
        tree: entries,
      });
      if (newTree.status !== 201 || !newTree.json.sha) throw new Error("Не удалось создать дерево GitHub");

      const newCommit = await this.githubJson("/git/commits", "POST", {
        message: "Obsidian: первоначальная автоматическая загрузка хранилища",
        tree: newTree.json.sha,
        parents: [headSha],
      });
      if (newCommit.status !== 201 || !newCommit.json.sha) throw new Error("Не удалось создать коммит GitHub");

      const updatedRef = await this.githubJson(
        `/git/refs/heads/${encodeURIComponent(this.settings.branch)}`,
        "PATCH",
        { sha: newCommit.json.sha, force: false }
      );
      if (updatedRef.status !== 200) throw new Error(`Не удалось обновить ветку: ${updatedRef.status}`);

      this.settings.initialUploadComplete = true;
      this.settings.lastRemoteHead = newCommit.json.sha;
      await this.saveSettings();
      new Notice(`Хранилище загружено: ${changed.length} файлов`, 10000);
    } catch (error) {
      console.error("ChatGPT GitHub Bridge initial upload:", error);
      new Notice("Не удалось полностью загрузить хранилище. Плагин повторит попытку после перезапуска", 10000);
    } finally {
      this.uploadRunning = false;
    }
  }

  async verifyAllFiles() {
    if (!this.requireSettings() || this.syncRunning) return;
    this.syncRunning = true;
    try {
      const head = await this.getRemoteHead();
      if (!head) throw new Error("Не удалось получить ветку GitHub");
      await this.syncRemoteChanges(head, true);
    } catch (error) {
      console.error("ChatGPT GitHub Bridge full verification:", error);
      new Notice("Не удалось проверить файлы GitHub");
    } finally {
      this.syncRunning = false;
    }
  }

  async backgroundSync(showNotice) {
    if (!this.settings.autoSync && !showNotice) return;
    if (!this.requireSettings(showNotice) || this.syncRunning || this.localOperationsPending || this.pendingPushes.size) return;

    this.syncRunning = true;
    try {
      const head = await this.getRemoteHead();
      if (!head) throw new Error("Не удалось получить ветку GitHub");

      if (this.settings.autoUpdate && (head !== this.settings.lastRemoteHead || !this.companionChecked)) {
        this.companionChecked = true;
        await this.checkForCompanionPlugin(false, head);
      }

      await this.checkForPluginUpdate(false);
      const headChanged = head !== this.settings.lastRemoteHead;
      const fullScanDue = Date.now() - this.lastFullScanAt >= 5 * 60 * 1000;
      if (headChanged || fullScanDue || showNotice) {
        await this.syncRemoteChanges(head, showNotice);
        this.lastFullScanAt = Date.now();
      }
    } catch (error) {
      console.error("ChatGPT GitHub Bridge sync:", error);
      if (showNotice) new Notice("Не удалось выполнить синхронизацию");
    } finally {
      this.syncRunning = false;
    }
  }
};

class BridgeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "ChatGPT GitHub Bridge" });

    new Setting(containerEl).setName("Автоматическая синхронизация").setDesc("Отправляет локальные изменения и получает изменения ChatGPT").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
        this.plugin.settings.autoSync = value;
        await this.plugin.saveSettings();
      })
    );

    new Setting(containerEl).setName("Автоматические обновления").setDesc("Плагин сам скачивает новые версии из GitHub").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.autoUpdate).onChange(async (value) => {
        this.plugin.settings.autoUpdate = value;
        await this.plugin.saveSettings();
      })
    );

    new Setting(containerEl).setName("Владелец GitHub").addText((text) =>
      text.setValue(this.plugin.settings.owner).onChange(async (value) => {
        this.plugin.settings.owner = value.trim();
        await this.plugin.saveSettings();
      })
    );

    new Setting(containerEl).setName("Репозиторий").addText((text) =>
      text.setValue(this.plugin.settings.repository).onChange(async (value) => {
        this.plugin.settings.repository = value.trim();
        await this.plugin.saveSettings();
      })
    );

    new Setting(containerEl).setName("Ветка").addText((text) =>
      text.setValue(this.plugin.settings.branch).onChange(async (value) => {
        this.plugin.settings.branch = value.trim() || "main";
        await this.plugin.saveSettings();
      })
    );

    new Setting(containerEl)
      .setName("Токен GitHub")
      .setDesc("Хранится в настройках Obsidian на устройстве и исключён из GitHub")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("github_pat_...").setValue(this.plugin.settings.token).onChange(async (value) => {
          this.plugin.settings.token = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName("Проверка подключения").addButton((button) =>
      button.setButtonText("Проверить").setCta().onClick(() => this.plugin.checkGitHub())
    );
  }
}
