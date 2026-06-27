/**
 * Flash Manager - Web Serial + esptool-js firmware flashing for ESP8266 boards.
 */
'use strict';

(function () {
  const BOARD_TYPES = ['vehicle', 'ground'];
  const DEFAULT_VEHICLE_IDS = ['DEMO_1', 'DEMO_2', 'DEMO_3', 'BUS_01', 'BUS_02'];
  const FLASH_BAUD = 921600;
  const MONITOR_BAUD = 115200;

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function time() {
    return new Date().toLocaleTimeString('th-TH', { hour12: false });
  }

  function htmlEscape(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function arrayBufferToBinaryString(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let result = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      result += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return result;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  function getEsptoolConstructors() {
    const root = window.esptool || window.esptooljs || window;
    const ESPLoader = root.ESPLoader || window.ESPLoader;
    const Transport = root.Transport || window.Transport;
    if (!ESPLoader || !Transport) {
      throw new Error('esptool-js is not loaded. Check the CDN script in admin.html.');
    }
    return { ESPLoader, Transport };
  }

  class FlashManager {
    constructor() {
      this.boards = [];
      this.manifest = null;
      this.flashQueue = [];
      this.isFlashing = false;
      this.events = new Map();
      this.nextBoardId = 1;
    }

    on(event, callback) {
      if (!this.events.has(event)) this.events.set(event, new Set());
      this.events.get(event).add(callback);
      return () => this.events.get(event)?.delete(callback);
    }

    emit(event, data) {
      this.events.get(event)?.forEach(callback => {
        try { callback(data); } catch (error) { console.error(error); }
      });
    }

    async loadManifest() {
      const response = await fetch('/firmware/manifest.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('Cannot load firmware manifest');
      this.manifest = await response.json();
      this.emit('manifest', { manifest: this.manifest, files: this.getFirmwareList() });
      return this.manifest;
    }

    getFirmwareList() {
      if (!this.manifest?.boards) return [];
      return Object.entries(this.manifest.boards).map(([type, info]) => ({
        type,
        filename: info.filename,
        description: info.description,
      }));
    }

    async fetchFirmwareBin(filename) {
      const response = await fetch(`/firmware/${encodeURIComponent(filename)}`);
      if (!response.ok) {
        throw new Error(`Firmware not found: ${filename} (${response.status})`);
      }
      return response.arrayBuffer();
    }

    supportsSerial() {
      return 'serial' in navigator;
    }

    makePortId(port) {
      const info = typeof port.getInfo === 'function' ? port.getInfo() : {};
      const vendor = info.usbVendorId ? info.usbVendorId.toString(16).padStart(4, '0') : 'usb';
      const product = info.usbProductId ? info.usbProductId.toString(16).padStart(4, '0') : 'serial';
      return `BOARD_${this.nextBoardId++}_${vendor}_${product}`;
    }

    describePort(port) {
      const info = typeof port.getInfo === 'function' ? port.getInfo() : {};
      if (info.usbVendorId || info.usbProductId) {
        const vendor = info.usbVendorId ? `VID ${info.usbVendorId.toString(16).padStart(4, '0')}` : 'VID ?';
        const product = info.usbProductId ? `PID ${info.usbProductId.toString(16).padStart(4, '0')}` : 'PID ?';
        return `${vendor} / ${product}`;
      }
      return `Serial Port ${this.boards.length + 1}`;
    }

    addPort(port) {
      const existing = this.boards.find(board => board.port === port);
      if (existing) return existing;
      const board = {
        port,
        portId: this.makePortId(port),
        portInfo: typeof port.getInfo === 'function' ? port.getInfo() : {},
        label: this.describePort(port),
        boardType: '',
        vehicleId: 'DEMO_1',
        status: 'not_configured',
        progress: 0,
        chipInfo: null,
        monitor: null,
      };
      this.boards.push(board);
      this.emit('boards', this.boards);
      return board;
    }

    async scanPorts() {
      if (!this.supportsSerial()) {
        this.emit('error', new Error('Web Serial requires Chrome or Edge'));
        return [];
      }
      const ports = await navigator.serial.getPorts();
      ports.forEach(port => this.addPort(port));
      this.emit('boards', this.boards);
      return this.boards;
    }

    async requestNewPort() {
      if (!this.supportsSerial()) throw new Error('Web Serial requires Chrome or Edge');
      const port = await navigator.serial.requestPort();
      const board = this.addPort(port);
      this.emit('log', `[${time()}] Added ${board.label}`);
      return board;
    }

    async identifyBoard(board) {
      const { ESPLoader, Transport } = getEsptoolConstructors();
      const transport = new Transport(board.port, true);
      const terminal = {
        clean: () => {},
        writeLine: line => this.emit('log', `[${time()}] ${line}`),
        write: data => data && this.emit('log', String(data)),
      };
      const flasher = new ESPLoader({ transport, baudrate: FLASH_BAUD, terminal });
      await flasher.main_fn();
      const chipInfo = {
        chipName: typeof flasher.chipName === 'function' ? flasher.chipName() : flasher.chipName || 'ESP8266',
        macAddress: typeof flasher.macAddr === 'function' ? flasher.macAddr() : '',
      };
      await transport.disconnect();
      board.chipInfo = chipInfo;
      this.emit('boards', this.boards);
      return chipInfo;
    }

    setBoardType(portId, type) {
      const board = this.boards.find(item => item.portId === portId);
      if (!board || !BOARD_TYPES.includes(type)) return;
      board.boardType = type;
      board.status = 'ready';
      if (type === 'ground') board.vehicleId = '';
      if (type === 'vehicle' && !board.vehicleId) board.vehicleId = 'DEMO_1';
      this.emit('boardStatus', { portId, status: board.status });
      this.emit('boards', this.boards);
    }

    setVehicleId(portId, vehicleId) {
      const board = this.boards.find(item => item.portId === portId);
      if (!board) return;
      board.vehicleId = String(vehicleId || '').trim();
      this.emit('boards', this.boards);
    }

    getFirmwareForBoard(board) {
      if (!this.manifest?.boards?.[board.boardType]) {
        throw new Error(`No manifest entry for ${board.boardType || 'unconfigured'} board`);
      }
      const config = this.manifest.boards[board.boardType];
      if (!config.filename) throw new Error(`Firmware filename missing for ${board.boardType}`);
      return config;
    }

    async flashAll() {
      if (this.isFlashing) return;
      this.isFlashing = true;
      this.flashQueue = this.boards.filter(board => board.boardType && ['ready', 'done', 'error'].includes(board.status));

      if (!this.flashQueue.length) {
        this.emit('log', `[${time()}] No configured boards ready to flash`);
      }

      for (const board of this.flashQueue) {
        this.emit('boardStatus', { portId: board.portId, status: 'flashing' });
        this.emit('log', `[${time()}] Starting flash: ${board.label} -> ${board.boardType}`);

        try {
          await this.flashBoard(board);
          this.emit('boardStatus', { portId: board.portId, status: 'done' });
          this.emit('log', `[${time()}] ${board.label} flash complete`);
          await sleep(2000);
        } catch (error) {
          this.emit('boardStatus', { portId: board.portId, status: 'error' });
          this.emit('log', `[${time()}] ${board.label} failed: ${error.message}`);
        }
      }

      this.isFlashing = false;
      this.emit('complete');
    }

    async flashSingle(portId) {
      if (this.isFlashing) return;
      const board = this.boards.find(item => item.portId === portId);
      if (!board) throw new Error('Board not found');
      this.isFlashing = true;
      try {
        this.emit('boardStatus', { portId, status: 'flashing' });
        await this.flashBoard(board);
        this.emit('boardStatus', { portId, status: 'done' });
        this.emit('complete');
      } catch (error) {
        this.emit('boardStatus', { portId, status: 'error' });
        this.emit('error', error);
        throw error;
      } finally {
        this.isFlashing = false;
      }
    }

    async flashBoard(board) {
      const firmware = this.getFirmwareForBoard(board);
      const offset = Number.parseInt(firmware.flashOffset || '0x0', 16) || 0;
      const { ESPLoader, Transport } = getEsptoolConstructors();
      const transport = new Transport(board.port, true);
      const terminal = {
        clean: () => {},
        writeLine: line => this.emit('log', `[${time()}] ${line}`),
        write: data => data && this.emit('log', String(data)),
      };
      const flasher = new ESPLoader({ transport, baudrate: FLASH_BAUD, terminal });

      try {
        await flasher.main_fn();
        this.emit('log', `[${time()}] Connected. Downloading ${firmware.filename}...`);
        const binData = await this.fetchFirmwareBin(firmware.filename);
        const fileArray = [{ data: arrayBufferToBinaryString(binData), address: offset }];

        await flasher.write_flash({
          fileArray,
          flash_mode: 'dio',
          flash_freq: '80m',
          flash_size: 'detect',
          compress: true,
          reportProgress: (_fileIndex, written, total) => {
            const percent = total > 0 ? Math.round((written / total) * 100) : 0;
            this.emit('progress', { portId: board.portId, percent, written, total });
          },
        });
      } finally {
        await transport.disconnect().catch(() => {});
      }
    }

    async openMonitor(portId) {
      const board = this.boards.find(item => item.portId === portId);
      if (!board || board.monitor) return;
      await board.port.open({ baudRate: MONITOR_BAUD });
      const reader = board.port.readable.getReader();
      const decoder = new TextDecoder();
      board.monitor = { reader };
      this.emit('log', `[${time()}] Monitor open: ${board.label}`);

      (async () => {
        try {
          while (board.monitor) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) this.emit('log', decoder.decode(value, { stream: true }));
          }
        } catch (error) {
          if (board.monitor) this.emit('log', `[${time()}] Monitor error: ${error.message}`);
        } finally {
          reader.releaseLock();
          await board.port.close().catch(() => {});
          board.monitor = null;
          this.emit('boards', this.boards);
        }
      })();
      this.emit('boards', this.boards);
    }

    async closeMonitor(portId) {
      const board = this.boards.find(item => item.portId === portId);
      if (!board?.monitor) return;
      await board.monitor.reader.cancel().catch(() => {});
      board.monitor = null;
      this.emit('boards', this.boards);
    }

  }

  const flashManager = new FlashManager();
  window.flashManager = flashManager;
  window.FlashManager = FlashManager;

  function updateStatus(portId, status) {
    const board = flashManager.boards.find(item => item.portId === portId);
    if (board) {
      board.status = status;
      if (status === 'flashing') board.progress = 0;
      if (status === 'done') board.progress = 100;
    }
    renderBoards();
  }

  function appendFlashLog(message) {
    const consoleEl = document.getElementById('flash-console');
    if (!consoleEl) return;
    const line = document.createElement('div');
    line.textContent = String(message).trimEnd();
    consoleEl.appendChild(line);
    while (consoleEl.children.length > 300) consoleEl.removeChild(consoleEl.firstChild);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function renderFirmwareSummary() {
    const manifest = flashManager.manifest;
    const el = document.getElementById('firmware-summary');
    if (!el) return;
    if (!manifest) {
      el.innerHTML = '<div class="firmware-empty">Loading firmware manifest...</div>';
      return;
    }

    const rows = BOARD_TYPES.map(type => {
      const board = manifest.boards?.[type] || {};
      return `
        <div class="fw-row">
          <div>
            <strong>${type === 'vehicle' ? 'Vehicle' : 'Ground'}</strong>
            <span>${htmlEscape(board.description || '')}</span>
          </div>
          <code>${htmlEscape(board.filename || '-')}</code>
          <div><span class="fw-file-ok">repo static</span></div>
        </div>`;
    }).join('');

    el.innerHTML = `
      <div class="fw-version-line">
        <span class="fw-version">Package ${htmlEscape(manifest.version || '-')}</span>
        <span>Built ${htmlEscape(manifest.buildDate || '-')}</span>
        ${manifest.changelog ? `<span>${htmlEscape(manifest.changelog)}</span>` : ''}
      </div>
      ${rows}
    `;
  }

  function statusLabel(status) {
    return {
      not_configured: 'Not configured',
      ready: 'Ready',
      flashing: 'Flashing',
      done: 'Done',
      error: 'Error',
    }[status] || status || 'Not configured';
  }

  function renderBoards() {
    const body = document.getElementById('flash-board-list');
    if (!body) return;
    if (!flashManager.boards.length) {
      body.innerHTML = '<tr><td colspan="5" class="firmware-empty">No serial boards added yet.</td></tr>';
      return;
    }

    body.innerHTML = flashManager.boards.map(board => {
      const vehicleOptions = DEFAULT_VEHICLE_IDS
        .map(id => `<option value="${id}"${board.vehicleId === id ? ' selected' : ''}>${id}</option>`)
        .join('');
      const status = board.status || 'not_configured';
      const progressText = status === 'flashing' ? ` ${board.progress || 0}%` : '';
      return `
        <tr>
          <td>
            <strong>${htmlEscape(board.label)}</strong>
            <small>${htmlEscape(board.portId)}</small>
          </td>
          <td>
            <select class="admin-input flash-select" onchange="flashSetBoardType('${board.portId}', this.value)">
              <option value="">Choose type</option>
              <option value="vehicle"${board.boardType === 'vehicle' ? ' selected' : ''}>Vehicle</option>
              <option value="ground"${board.boardType === 'ground' ? ' selected' : ''}>Ground</option>
            </select>
          </td>
          <td>
            ${board.boardType === 'ground'
              ? '<span class="flash-muted">-</span>'
              : `<input class="admin-input flash-id-input" list="flash-vehicle-ids" value="${htmlEscape(board.vehicleId || '')}" onchange="flashSetVehicleId('${board.portId}', this.value)" placeholder="Vehicle ID" />`
            }
          </td>
          <td><span class="flash-status ${status}">${statusLabel(status)}${progressText}</span></td>
          <td>
            <div class="flash-actions">
              <button class="admin-btn admin-btn-primary" type="button" onclick="flashSingleBoard('${board.portId}')" ${!board.boardType || flashManager.isFlashing ? 'disabled' : ''}>Flash</button>
              <button class="admin-btn admin-btn-outline" type="button" onclick="toggleFlashMonitor('${board.portId}')" ${flashManager.isFlashing ? 'disabled' : ''}>${board.monitor ? 'Stop' : 'Monitor'}</button>
            </div>
          </td>
        </tr>`;
    }).join('');
  }

  function renderSerialSupport() {
    const warning = document.getElementById('flash-serial-warning');
    const addBtn = document.getElementById('flash-add-board-btn');
    const flashBtn = document.getElementById('flash-all-btn');
    const supported = flashManager.supportsSerial();
    if (warning) warning.hidden = supported;
    if (addBtn) addBtn.disabled = !supported;
    if (flashBtn) flashBtn.disabled = !supported;
  }

  function initFlashManagerUI() {
    renderSerialSupport();
    flashManager.on('manifest', renderFirmwareSummary);
    flashManager.on('boards', renderBoards);
    flashManager.on('boardStatus', data => updateStatus(data.portId, data.status));
    flashManager.on('progress', data => {
      const board = flashManager.boards.find(item => item.portId === data.portId);
      if (board) board.progress = data.percent;
      renderBoards();
      appendFlashLog(`[${time()}] ${board?.label || data.portId}: ${data.percent}% (${formatBytes(data.written)} / ${formatBytes(data.total)})`);
    });
    flashManager.on('log', appendFlashLog);
    flashManager.on('error', error => appendFlashLog(`[${time()}] ${error.message}`));
    flashManager.on('complete', () => appendFlashLog(`[${time()}] Flash queue complete`));

    flashManager.loadManifest().then(renderFirmwareSummary).catch(error => appendFlashLog(`[${time()}] ${error.message}`));
    flashManager.scanPorts().catch(error => appendFlashLog(`[${time()}] ${error.message}`));
  }

  window.flashRequestBoard = async function () {
    try {
      await flashManager.requestNewPort();
      renderBoards();
    } catch (error) {
      appendFlashLog(`[${time()}] ${error.message}`);
    }
  };

  window.flashScanBoards = async function () {
    try {
      await flashManager.scanPorts();
      renderBoards();
    } catch (error) {
      appendFlashLog(`[${time()}] ${error.message}`);
    }
  };

  window.flashSetBoardType = function (portId, type) {
    flashManager.setBoardType(portId, type);
  };

  window.flashSetVehicleId = function (portId, vehicleId) {
    flashManager.setVehicleId(portId, vehicleId);
  };

  window.flashAllBoards = async function () {
    try {
      await flashManager.flashAll();
    } catch (error) {
      appendFlashLog(`[${time()}] ${error.message}`);
    } finally {
      renderBoards();
    }
  };

  window.flashSingleBoard = async function (portId) {
    try {
      await flashManager.flashSingle(portId);
    } catch (error) {
      appendFlashLog(`[${time()}] ${error.message}`);
    } finally {
      renderBoards();
    }
  };

  window.toggleFlashMonitor = async function (portId) {
    const board = flashManager.boards.find(item => item.portId === portId);
    try {
      if (board?.monitor) await flashManager.closeMonitor(portId);
      else await flashManager.openMonitor(portId);
    } catch (error) {
      appendFlashLog(`[${time()}] ${error.message}`);
    }
  };

  window.clearFlashConsole = function () {
    const consoleEl = document.getElementById('flash-console');
    if (consoleEl) consoleEl.innerHTML = '';
  };

  window.copyFlashConsole = async function () {
    const consoleEl = document.getElementById('flash-console');
    if (!consoleEl) return;
    await navigator.clipboard.writeText(consoleEl.innerText || '');
    appendFlashLog(`[${time()}] Console copied`);
  };

  document.addEventListener('DOMContentLoaded', initFlashManagerUI);
})();
