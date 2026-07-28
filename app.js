(() => {
  'use strict';

  const MAX_FILE_SIZE = 5 * 1024 * 1024;
  const MAX_SOURCE_FILE_SIZE = 25 * 1024 * 1024;
  const IMAGE_MAX_DIMENSION = 900;
  const IMAGE_QUALITY = 0.82;
  const CHUNK_SIZE = 16 * 1024;
  const BUFFER_LIMIT = 512 * 1024;
  const HEARTBEAT_INTERVAL = 5000;
  const HEARTBEAT_TIMEOUT = 16000;
  const RECOVERY_GRACE = 12000;
  const CODE_PREFIX = 'water-webrtc-v2.';
  const LEGACY_CODE_PREFIX = 'water-webrtc-v1.';
  const HISTORY_DB = 'water-io-local-chat';
  const HISTORY_STORE = 'messages';
  const CONNECTION_ROLE_KEY = 'water-io-connection-role';
  const ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ];

  const $ = selector => document.querySelector(selector);
  const setupView = $('#setupView');
  const startView = $('#startView');
  const roleView = $('#roleView');
  const chatView = $('#chatView');
  const connectStartButton = $('#connectStart');
  const backToStartButton = $('#backToStart');
  const statusPill = $('#statusPill');
  const statusText = $('#statusText');
  const chatStatus = $('#chatStatus');
  const chatStatusText = $('#chatStatusText');
  const wakeStatus = $('#wakeStatus');
  const connectionDetail = $('#connectionDetail');
  const localCode = $('#localCode');
  const remoteCode = $('#remoteCode');
  const copyCode = $('#copyCode');
  const createOfferButton = $('#createOffer');
  const scanQrButton = $('#scanQr');
  const useCodeButton = $('#useCode');
  const resetButton = $('#resetConnection');
  const qrPanel = $('#qrPanel');
  const qrCanvas = $('#qrCanvas');
  const qrTitle = $('#qrTitle');
  const qrCaption = $('#qrCaption');
  const scanReturnButton = $('#scanReturnCode');
  const pairingModal = $('#pairingModal');
  const closePairingButton = $('#closePairing');
  const scannerModal = $('#scannerModal');
  const closeScannerButton = $('#closeScanner');
  const scannerVideo = $('#scannerVideo');
  const scannerCanvas = $('#scannerCanvas');
  const cameraStatus = $('#cameraStatus');
  const reconnectNotice = $('#reconnectNotice');
  const reconnectText = $('#reconnectText');
  const reconnectShowButton = $('#reconnectShow');
  const reconnectScanButton = $('#reconnectScan');
  const messageForm = $('#messageForm');
  const messageInput = $('#messageInput');
  const sendMessageButton = $('#sendMessage');
  const imageInput = $('#imageInput');
  const imageLabel = $('#imageLabel');
  const transferStatus = $('#transferStatus');
  const messages = $('#messages');
  const emptyState = $('#emptyState');
  const emojiToggle = $('#emojiToggle');
  const emojiPicker = $('#emojiPicker');
  const historyNotice = $('#historyNotice');
  const clearHistoryButton = $('#clearHistory');

  let peer = null;
  let channel = null;
  let role = null;
  let incomingFile = null;
  let sendingFile = false;
  let scannerStream = null;
  let scannerFrame = 0;
  let scannerBusy = false;
  let lastScanTime = 0;
  let heartbeatTimer = 0;
  let recoveryTimer = 0;
  let lastPongAt = 0;
  let connectionOwner = readSavedConnectionOwner();
  let sessionWasConnected = false;
  let recoveryOfferInProgress = false;
  let pairingDismissed = false;
  let wakeLock = null;
  let wakeLockWanted = false;
  let historyDbPromise = null;
  const objectUrls = new Set();

  function setStatus(text, state = 'idle', detail) {
    statusText.textContent = text;
    statusPill.dataset.state = state;
    statusPill.hidden = false;
    chatStatusText.textContent = text;
    chatStatus.dataset.state = state;
    if (detail) connectionDetail.textContent = detail;
  }

  function showStart() {
    setupView.hidden = false;
    startView.hidden = false;
    roleView.hidden = true;
    chatView.hidden = true;
    reconnectNotice.hidden = true;
    emojiPicker.hidden = true;
    hidePairing();
    statusPill.hidden = true;
    document.body.classList.remove('chat-active');
  }

  function showRoleChoices() {
    setupView.hidden = false;
    startView.hidden = true;
    roleView.hidden = false;
    chatView.hidden = true;
    reconnectNotice.hidden = true;
    emojiPicker.hidden = true;
    hidePairing();
    statusPill.hidden = true;
    document.body.classList.remove('chat-active');
  }

  function showPairing(force = false) {
    if (pairingDismissed && !force) return;
    if (force) pairingDismissed = false;
    pairingModal.hidden = false;
    document.body.classList.add('modal-open');
  }

  function hidePairing() {
    pairingModal.hidden = true;
    if (scannerModal.hidden) document.body.classList.remove('modal-open');
  }

  function showChat() {
    setupView.hidden = true;
    chatView.hidden = false;
    reconnectNotice.hidden = true;
    hidePairing();
    document.body.classList.add('chat-active');
    requestAnimationFrame(() => {
      messages.scrollTop = messages.scrollHeight;
    });
  }

  function setExchangeEnabled(enabled) {
    messageInput.disabled = !enabled;
    sendMessageButton.disabled = !enabled;
    emojiToggle.disabled = !enabled;
    imageInput.disabled = !enabled || sendingFile;
    imageLabel.setAttribute('aria-disabled', String(!enabled || sendingFile));
    if (!enabled) emojiPicker.hidden = true;
  }

  function showReconnectChoices(message = 'Reconnect with your friend') {
    showChat();
    reconnectText.textContent = message;
    reconnectNotice.hidden = false;
  }

  function readSavedConnectionOwner() {
    try {
      const saved = localStorage.getItem(CONNECTION_ROLE_KEY);
      if (saved === 'owner') return true;
      if (saved === 'guest') return false;
    } catch {
      // Local storage is optional.
    }
    return null;
  }

  function saveConnectionOwner(value) {
    connectionOwner = value;
    try {
      if (value === true) localStorage.setItem(CONNECTION_ROLE_KEY, 'owner');
      else if (value === false) localStorage.setItem(CONNECTION_ROLE_KEY, 'guest');
      else localStorage.removeItem(CONNECTION_ROLE_KEY);
    } catch {
      // The live connection still works if storage is unavailable.
    }
  }

  function setWakeStatus(state, detail = '') {
    wakeStatus.dataset.state = state;
    wakeStatus.hidden = state === 'off';
    wakeStatus.disabled = ['active', 'requesting', 'unsupported'].includes(state);
    wakeStatus.title = detail;
    if (state === 'active') wakeStatus.textContent = 'Screen stays on';
    else if (state === 'requesting') wakeStatus.textContent = 'Keeping screen on…';
    else if (state === 'unsupported') wakeStatus.textContent = 'Wake lock unavailable';
    else if (state === 'retry') wakeStatus.textContent = 'Screen may sleep · retry';
  }

  async function requestWakeLock() {
    wakeLockWanted = true;
    if (!('wakeLock' in navigator)) {
      setWakeStatus('unsupported', 'This browser does not offer screen wake lock.');
      return;
    }
    if (document.visibilityState !== 'visible') {
      setWakeStatus('retry', 'Return to this page and tap to retry.');
      return;
    }
    if (wakeLock && !wakeLock.released) {
      setWakeStatus('active');
      return;
    }

    setWakeStatus('requesting');
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      if (!wakeLockWanted) {
        await sentinel.release();
        return;
      }
      wakeLock = sentinel;
      setWakeStatus('active');
      sentinel.addEventListener('release', () => {
        if (wakeLock === sentinel) wakeLock = null;
        if (wakeLockWanted) {
          setWakeStatus('retry', 'Android may block wake lock while Battery Saver is active.');
        } else {
          setWakeStatus('off');
        }
      });
    } catch (error) {
      wakeLock = null;
      const reason = error?.name === 'NotAllowedError'
        ? 'Battery Saver, browser settings, or an embedded browser blocked the wake lock.'
        : 'The browser could not keep the screen on.';
      setWakeStatus('retry', reason);
    }
  }

  async function releaseWakeLock() {
    wakeLockWanted = false;
    const currentLock = wakeLock;
    wakeLock = null;
    setWakeStatus('off');
    try {
      await currentLock?.release();
    } catch {
      // The browser may already have released it.
    }
  }

  function messageId() {
    return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function openHistoryDb() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('Local history is unavailable.'));
    if (historyDbPromise) return historyDbPromise;

    historyDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(HISTORY_DB, 1);
      request.addEventListener('upgradeneeded', () => {
        if (!request.result.objectStoreNames.contains(HISTORY_STORE)) {
          request.result.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
        }
      });
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error));
    });
    return historyDbPromise;
  }

  async function saveHistoryRecord(record) {
    try {
      const db = await openHistoryDb();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(HISTORY_STORE, 'readwrite');
        transaction.objectStore(HISTORY_STORE).put(record);
        transaction.addEventListener('complete', resolve);
        transaction.addEventListener('error', () => reject(transaction.error));
      });
      historyNotice.hidden = false;
    } catch {
      // Private browsing can disable IndexedDB; chat still works for this tab.
    }
  }

  async function restoreHistory() {
    try {
      const db = await openHistoryDb();
      const records = await new Promise((resolve, reject) => {
        const transaction = db.transaction(HISTORY_STORE, 'readonly');
        const request = transaction.objectStore(HISTORY_STORE).getAll();
        request.addEventListener('success', () => resolve(request.result || []));
        request.addEventListener('error', () => reject(request.error));
      });
      records.sort((a, b) => a.timestamp - b.timestamp);
      for (const record of records) {
        if (record.type === 'text') {
          appendMessage(record.text, record.mine, record.timestamp, false, record.id);
        } else if (record.type === 'image' && record.blob instanceof Blob) {
          appendImage(record.blob, record.name, record.mine, record.timestamp, false, record.id);
        }
      }
      historyNotice.hidden = records.length === 0;
    } catch {
      historyNotice.hidden = true;
    }
  }

  async function clearHistory() {
    try {
      const db = await openHistoryDb();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(HISTORY_STORE, 'readwrite');
        transaction.objectStore(HISTORY_STORE).clear();
        transaction.addEventListener('complete', resolve);
        transaction.addEventListener('error', () => reject(transaction.error));
      });
    } catch {
      // Clear the visible history even when storage is unavailable.
    }
    objectUrls.forEach(url => URL.revokeObjectURL(url));
    objectUrls.clear();
    messages.replaceChildren(emptyState);
    emptyState.hidden = false;
    historyNotice.hidden = true;
  }

  function stopHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = 0;
  }

  function clearRecoveryTimer() {
    clearTimeout(recoveryTimer);
    recoveryTimer = 0;
  }

  function startHeartbeat() {
    stopHeartbeat();
    lastPongAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (!canSend()) return;
      if (Date.now() - lastPongAt > HEARTBEAT_TIMEOUT) {
        scheduleRecovery('The peer stopped responding.');
      }
      try {
        sendJson({ kind: 'heartbeat-ping', sentAt: Date.now() });
      } catch {
        scheduleRecovery('The heartbeat could not reach the peer.');
      }
    }, HEARTBEAT_INTERVAL);
  }

  function markConnected() {
    clearRecoveryTimer();
    recoveryOfferInProgress = false;
    sessionWasConnected = true;
    qrPanel.hidden = true;
    showChat();
    setStatus(
      'Connected',
      'connected',
      'Your private chat is ready.'
    );
    setExchangeEnabled(true);
    startHeartbeat();
    void requestWakeLock();
  }

  function scheduleRecovery(reason) {
    if (recoveryTimer || recoveryOfferInProgress) return;
    setExchangeEnabled(false);
    setStatus('Reconnecting…', 'working', `${reason} Trying the existing route first.`);
    recoveryTimer = setTimeout(beginStaticRecovery, RECOVERY_GRACE);
  }

  async function beginStaticRecovery() {
    clearRecoveryTimer();
    stopHeartbeat();
    setExchangeEnabled(false);

    if (connectionOwner === true) {
      if (recoveryOfferInProgress) return;
      recoveryOfferInProgress = true;
      showReconnectChoices('A fresh code is ready');
      setStatus('New scan needed', 'working', 'Show this fresh code to your friend.');
      await createOffer({ recovery: true });
      recoveryOfferInProgress = false;
      return;
    }

    showReconnectChoices('The connection needs a fresh scan');
    setStatus(
      'Scan needed',
      'error',
      'Your friend will show a fresh code.'
    );
  }

  function encodeBytes(bytes) {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function decodeBytes(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function transformBytes(bytes, format) {
    const transformer = format === 'compress'
      ? new CompressionStream('deflate-raw')
      : new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(transformer);
    const response = new Response(stream);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function packDescription(description) {
    const json = JSON.stringify({ type: description.type, sdp: description.sdp });
    const bytes = new TextEncoder().encode(json);
    if ('CompressionStream' in window) {
      const compressed = await transformBytes(bytes, 'compress');
      return `${CODE_PREFIX}z.${encodeBytes(compressed)}`;
    }
    return `${CODE_PREFIX}j.${encodeBytes(bytes)}`;
  }

  async function unpackDescription(value) {
    const compact = value.trim().replace(/\s+/g, '');
    let bytes;

    if (compact.startsWith(LEGACY_CODE_PREFIX)) {
      bytes = decodeBytes(compact.slice(LEGACY_CODE_PREFIX.length));
    } else if (compact.startsWith(`${CODE_PREFIX}z.`)) {
      const compressed = decodeBytes(compact.slice(`${CODE_PREFIX}z.`.length));
      if (!('DecompressionStream' in window)) {
        throw new Error('This browser cannot read compressed connection codes.');
      }
      bytes = await transformBytes(compressed, 'decompress');
    } else if (compact.startsWith(`${CODE_PREFIX}j.`)) {
      bytes = decodeBytes(compact.slice(`${CODE_PREFIX}j.`.length));
    } else {
      throw new Error('This is not a water.io connection code.');
    }

    const json = new TextDecoder().decode(bytes);
    const description = JSON.parse(json);
    if (!description || !['offer', 'answer'].includes(description.type) || !description.sdp) {
      throw new Error('The connection code is incomplete.');
    }
    return description;
  }

  function isConnectionCode(value) {
    const compact = String(value || '').trim().replace(/\s+/g, '');
    return compact.startsWith(CODE_PREFIX) || compact.startsWith(LEGACY_CODE_PREFIX);
  }

  async function renderQr(code, type) {
    if (!window.qrcode) {
      qrPanel.hidden = true;
      showPairing();
      connectionDetail.textContent = 'The QR code could not be shown. Try the text-code option.';
      return;
    }

    try {
      const codeMatrix = window.qrcode(0, 'L');
      codeMatrix.addData(code, 'Byte');
      codeMatrix.make();
      const modules = codeMatrix.getModuleCount();
      const quietZone = 4;
      const scale = Math.max(2, Math.floor(420 / (modules + quietZone * 2)));
      const size = (modules + quietZone * 2) * scale;
      const context = qrCanvas.getContext('2d');
      qrCanvas.width = size;
      qrCanvas.height = size;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, size, size);
      context.fillStyle = '#173d3a';
      for (let row = 0; row < modules; row++) {
        for (let column = 0; column < modules; column++) {
          if (!codeMatrix.isDark(row, column)) continue;
          context.fillRect(
            (column + quietZone) * scale,
            (row + quietZone) * scale,
            scale,
            scale
          );
        }
      }
      const reconnecting = type.startsWith('reconnect-');
      const offering = type.endsWith('offer');
      qrTitle.textContent = offering
        ? (reconnecting ? 'Let your friend scan again' : 'Let your friend scan this')
        : 'Scan this back on the first phone';
      qrCaption.textContent = offering
        ? (reconnecting ? 'This fresh code will bring your chat back.' : 'Keep this screen open while they scan.')
        : (reconnecting ? 'One last scan will bring your chat back.' : 'One last scan connects both phones.');
      scanReturnButton.hidden = !offering;
      qrPanel.hidden = false;
      showPairing();
    } catch (error) {
      console.error(error);
      qrPanel.hidden = true;
      showPairing();
      connectionDetail.textContent = 'This code is too large for QR. Try the text-code option.';
    }
  }

  function stopScanner() {
    cancelAnimationFrame(scannerFrame);
    scannerFrame = 0;
    scannerBusy = false;
    scannerStream?.getTracks().forEach(track => track.stop());
    scannerStream = null;
    scannerVideo.srcObject = null;
    scannerModal.hidden = true;
    if (pairingModal.hidden) document.body.classList.remove('modal-open');
  }

  async function scanCameraFrame(timestamp) {
    if (!scannerStream || scannerModal.hidden) return;
    scannerFrame = requestAnimationFrame(scanCameraFrame);
    if (scannerBusy || timestamp - lastScanTime < 120 || scannerVideo.readyState < 2) return;
    lastScanTime = timestamp;

    const width = scannerVideo.videoWidth;
    const height = scannerVideo.videoHeight;
    if (!width || !height) return;
    scannerCanvas.width = width;
    scannerCanvas.height = height;
    const context = scannerCanvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(scannerVideo, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    const result = window.jsQR(pixels.data, width, height, { inversionAttempts: 'dontInvert' });
    if (!result?.data || !isConnectionCode(result.data)) return;

    scannerBusy = true;
    cameraStatus.textContent = 'Found it — connecting…';
    const scannedCode = result.data;
    stopScanner();
    remoteCode.value = scannedCode;
    await useRemoteDescription(scannedCode);
  }

  async function startScanner() {
    if (!window.jsQR) {
      setStatus('Scanner unavailable', 'error', 'The QR scanner did not load. Use the text-code fallback.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('Camera unavailable', 'error', 'Camera access requires HTTPS. Use the text-code fallback.');
      return;
    }

    scannerModal.hidden = false;
    document.body.classList.add('modal-open');
    cameraStatus.textContent = 'Opening your camera…';

    try {
      scannerStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 1280 }
        }
      });
      scannerVideo.srcObject = scannerStream;
      await scannerVideo.play();
      cameraStatus.textContent = 'Hold their code inside the square.';
      lastScanTime = 0;
      scannerFrame = requestAnimationFrame(scanCameraFrame);
    } catch (error) {
      console.error(error);
      stopScanner();
      setStatus('Camera permission needed', 'error', 'Allow camera access, or ask your friend to share the text code.');
    }
  }

  function waitForIceGathering(timeout = 10000) {
    if (!peer || peer.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(finish, timeout);
      function finish() {
        clearTimeout(timer);
        peer?.removeEventListener('icegatheringstatechange', checkState);
        resolve();
      }
      function checkState() {
        if (peer?.iceGatheringState === 'complete') finish();
      }
      peer.addEventListener('icegatheringstatechange', checkState);
    });
  }

  function createPeer() {
    const instance = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      iceCandidatePoolSize: 2
    });

    instance.addEventListener('datachannel', event => configureChannel(event.channel));
    instance.addEventListener('connectionstatechange', () => {
      if (peer !== instance) return;
      const state = instance.connectionState;
      if (state === 'connected') {
        markConnected();
      } else if (state === 'connecting') {
        setStatus('Connecting…', 'working');
      } else if (state === 'failed') {
        void beginStaticRecovery();
      } else if (state === 'disconnected') {
        scheduleRecovery('The network route was interrupted.');
      } else if (state === 'closed') {
        void beginStaticRecovery();
      }
    });

    return instance;
  }

  function configureChannel(nextChannel) {
    channel = nextChannel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_LIMIT / 2;

    channel.addEventListener('open', () => {
      if (channel !== nextChannel) return;
      markConnected();
    });
    channel.addEventListener('close', () => {
      if (channel !== nextChannel) return;
      void beginStaticRecovery();
    });
    channel.addEventListener('error', () => {
      if (channel !== nextChannel) return;
      scheduleRecovery('The peer-to-peer data channel encountered an error.');
    });
    channel.addEventListener('message', event => {
      if (channel === nextChannel) handleIncomingData(event);
    });
  }

  function resetPeer({ forgetSession = false, keepRecoveryNotice = false } = {}) {
    stopScanner();
    stopHeartbeat();
    clearRecoveryTimer();
    const previousChannel = channel;
    const previousPeer = peer;
    peer = null;
    channel = null;
    role = null;
    if (forgetSession) {
      saveConnectionOwner(null);
      recoveryOfferInProgress = false;
    }
    previousChannel?.close();
    previousPeer?.close();
    incomingFile = null;
    sendingFile = false;
    localCode.value = '';
    remoteCode.value = '';
    copyCode.disabled = true;
    qrPanel.hidden = true;
    if (!keepRecoveryNotice) reconnectNotice.hidden = true;
    transferStatus.textContent = '';
    setExchangeEnabled(false);
    setStatus('Not connected', 'idle', 'Both phones should keep this page open while connecting.');
  }

  async function createOffer({ recovery = false } = {}) {
    resetPeer({ keepRecoveryNotice: recovery });
    saveConnectionOwner(true);
    if (!recovery) sessionWasConnected = false;
    connectStartButton.disabled = true;
    createOfferButton.disabled = true;
    reconnectShowButton.disabled = true;
    useCodeButton.disabled = true;
    showPairing(true);
    try {
      role = 'offerer';
      peer = createPeer();
      configureChannel(peer.createDataChannel('water-io-exchange', { ordered: true }));
      setStatus(
        recovery ? 'Making a fresh code…' : 'Making your code…',
        'working',
        'This usually takes only a moment.'
      );
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering();
      localCode.value = await packDescription(peer.localDescription);
      copyCode.disabled = false;
      await renderQr(localCode.value, recovery ? 'reconnect-offer' : 'offer');
      setStatus(
        recovery ? 'Fresh code ready' : 'Ready to scan',
        'working',
        recovery
          ? 'Let your friend scan this code again.'
          : 'Let your friend scan the code on this phone.'
      );
    } catch (error) {
      if (recovery) {
        console.error(error);
        showReconnectChoices('Could not make a fresh code');
        setStatus('Reconnect setup failed', 'error', error?.message || 'Could not create a fresh QR.');
      } else {
        showError(error);
      }
    } finally {
      connectStartButton.disabled = false;
      createOfferButton.disabled = false;
      reconnectShowButton.disabled = false;
      useCodeButton.disabled = false;
    }
  }

  async function useRemoteDescription(code = remoteCode.value) {
    useCodeButton.disabled = true;
    try {
      const description = await unpackDescription(typeof code === 'string' ? code : remoteCode.value);

      if (description.type === 'offer') {
        const reconnecting = sessionWasConnected;
        pairingDismissed = false;
        saveConnectionOwner(false);
        resetPeer({ keepRecoveryNotice: reconnecting });
        role = 'answerer';
        peer = createPeer();
        setStatus(
          reconnecting ? 'Making a fresh reply…' : 'Making the return code…',
          'working',
          'This usually takes only a moment.'
        );
        await peer.setRemoteDescription(description);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        await waitForIceGathering();
        localCode.value = await packDescription(peer.localDescription);
        copyCode.disabled = false;
        await renderQr(localCode.value, reconnecting ? 'reconnect-answer' : 'answer');
        setStatus(
          reconnecting ? 'Fresh code ready' : 'One last scan',
          'working',
          reconnecting
            ? 'Ask your friend to scan this code again.'
            : 'Ask your friend to scan this code on the first phone.'
        );
      } else {
        if (!peer || role !== 'offerer') {
          throw new Error('Choose “Show my code” on this phone first.');
        }
        await peer.setRemoteDescription(description);
        setStatus('Connecting…', 'working', 'The two phones are finding each other.');
      }
    } catch (error) {
      showError(error);
    } finally {
      useCodeButton.disabled = false;
    }
  }

  function showError(error) {
    console.error(error);
    setStatus('That code did not work', 'error', error?.message || 'Please try scanning again.');
  }

  async function copyLocalCode() {
    if (!localCode.value) return;
    try {
      await navigator.clipboard.writeText(localCode.value);
      copyCode.textContent = 'Copied';
      setTimeout(() => { copyCode.textContent = 'Copy'; }, 1300);
    } catch {
      localCode.focus();
      localCode.select();
      document.execCommand('copy');
    }
  }

  function canSend() {
    return channel && channel.readyState === 'open';
  }

  function sendJson(payload) {
    if (!canSend()) throw new Error('The peer is not connected.');
    channel.send(JSON.stringify(payload));
  }

  function appendMessage(text, mine, timestamp = Date.now(), persist = true, id = messageId()) {
    emptyState.hidden = true;
    const item = document.createElement('div');
    item.className = `message${mine ? ' mine' : ''}`;
    item.dataset.messageId = id;
    const content = document.createElement('span');
    content.textContent = text;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${mine ? 'You' : 'Friend'} · ${new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    })}`;
    item.append(content, meta);
    messages.append(item);
    messages.scrollTop = messages.scrollHeight;
    if (persist) {
      void saveHistoryRecord({ id, type: 'text', text, mine, timestamp });
    }
  }

  function appendImage(blob, name, mine, timestamp = Date.now(), persist = true, id = messageId()) {
    emptyState.hidden = true;
    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    const item = document.createElement('div');
    item.className = `message image-message${mine ? ' mine' : ''}`;
    item.dataset.messageId = id;
    const image = document.createElement('img');
    image.src = url;
    image.alt = name || 'Shared image';
    const link = document.createElement('a');
    link.href = url;
    link.download = name || 'shared-image';
    link.textContent = `${mine ? 'Sent' : 'Download'} ${name || 'image'}`;
    item.append(image, link);
    messages.append(item);
    messages.scrollTop = messages.scrollHeight;
    if (persist) {
      void saveHistoryRecord({ id, type: 'image', blob, name, mine, timestamp });
    }
  }

  function handleRemoteEnd() {
    sessionWasConnected = false;
    resetPeer({ keepRecoveryNotice: true });
    showReconnectChoices('Your friend disconnected');
    setStatus('Disconnected', 'error', 'Your messages are safe. Reconnect whenever you are ready.');
  }

  function handleIncomingData(event) {
    if (typeof event.data === 'string') {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.kind === 'heartbeat-ping') {
        if (canSend()) sendJson({ kind: 'heartbeat-pong', sentAt: payload.sentAt });
        return;
      }

      if (payload.kind === 'heartbeat-pong') {
        lastPongAt = Date.now();
        if (recoveryTimer && peer?.connectionState === 'connected') markConnected();
        return;
      }

      if (payload.kind === 'session-end') {
        handleRemoteEnd();
      } else if (payload.kind === 'message' && typeof payload.text === 'string') {
        appendMessage(payload.text.slice(0, 500), false, payload.sentAt);
      } else if (payload.kind === 'file-start') {
        if (
          !payload.id ||
          !Number.isFinite(payload.size) ||
          payload.size < 0 ||
          payload.size > MAX_FILE_SIZE ||
          typeof payload.mime !== 'string' ||
          !payload.mime.startsWith('image/')
        ) {
          incomingFile = null;
          transferStatus.textContent = 'Rejected an invalid image';
          return;
        }
        incomingFile = {
          id: payload.id,
          name: String(payload.name || 'shared-image').slice(0, 160),
          mime: payload.mime,
          size: payload.size,
          sentAt: payload.sentAt || Date.now(),
          received: 0,
          chunks: []
        };
        transferStatus.textContent = `Receiving ${incomingFile.name}…`;
      } else if (payload.kind === 'file-end' && incomingFile?.id === payload.id) {
        if (incomingFile.received !== incomingFile.size) {
          transferStatus.textContent = 'Image transfer was incomplete';
          incomingFile = null;
          return;
        }
        const blob = new Blob(incomingFile.chunks, { type: incomingFile.mime });
        appendImage(blob, incomingFile.name, false, incomingFile.sentAt);
        transferStatus.textContent = `Received ${incomingFile.name}`;
        incomingFile = null;
      }
      return;
    }

    if (incomingFile && event.data instanceof ArrayBuffer) {
      const nextSize = incomingFile.received + event.data.byteLength;
      if (nextSize > incomingFile.size) {
        transferStatus.textContent = 'Rejected oversized image data';
        incomingFile = null;
        return;
      }
      incomingFile.chunks.push(event.data);
      incomingFile.received = nextSize;
      const percent = incomingFile.size
        ? Math.round(incomingFile.received / incomingFile.size * 100)
        : 100;
      transferStatus.textContent = `Receiving ${incomingFile.name} · ${percent}%`;
    }
  }

  function waitForBufferSpace() {
    if (!channel || channel.bufferedAmount <= BUFFER_LIMIT) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const activeChannel = channel;
      function cleanup() {
        activeChannel.removeEventListener('bufferedamountlow', onLow);
        activeChannel.removeEventListener('close', onClose);
      }
      function onLow() {
        cleanup();
        resolve();
      }
      function onClose() {
        cleanup();
        reject(new Error('The peer disconnected during transfer.'));
      }
      activeChannel.addEventListener('bufferedamountlow', onLow, { once: true });
      activeChannel.addEventListener('close', onClose, { once: true });
    });
  }

  async function loadImageSource(file) {
    if ('createImageBitmap' in window) {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        return {
          width: bitmap.width,
          height: bitmap.height,
          draw(context, width, height) {
            context.drawImage(bitmap, 0, 0, width, height);
          },
          close() {
            bitmap.close();
          }
        };
      } catch {
        // Fall through to the regular image decoder.
      }
    }

    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      draw(context, width, height) {
        context.drawImage(image, 0, 0, width, height);
      },
      close() {
        URL.revokeObjectURL(url);
      }
    };
  }

  async function prepareImageForTransfer(file) {
    if (!file.type.startsWith('image/')) throw new Error('Choose a photo or image.');
    if (file.size > MAX_SOURCE_FILE_SIZE) throw new Error('Choose an image smaller than 25 MB.');

    transferStatus.textContent = 'Preparing a smaller photo…';
    const source = await loadImageSource(file);
    try {
      const largestSide = Math.max(source.width, source.height);
      if (largestSide <= IMAGE_MAX_DIMENSION && file.size <= 500 * 1024) return file;

      const scale = Math.min(1, IMAGE_MAX_DIMENSION / largestSide);
      const width = Math.max(1, Math.round(source.width * scale));
      const height = Math.max(1, Math.round(source.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      source.draw(context, width, height);

      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', IMAGE_QUALITY));
      if (!blob) throw new Error('This image could not be resized.');
      const baseName = file.name.replace(/\.[^.]+$/, '') || 'photo';
      return new File([blob], `${baseName}.jpg`, {
        type: 'image/jpeg',
        lastModified: Date.now()
      });
    } finally {
      source.close();
    }
  }

  async function sendImage(file) {
    if (!canSend()) throw new Error('Reconnect before sending a photo.');

    sendingFile = true;
    setExchangeEnabled(true);

    try {
      const outgoing = await prepareImageForTransfer(file);
      if (outgoing.size > MAX_FILE_SIZE) throw new Error('The resized image is still too large to send.');
      const id = messageId();
      const sentAt = Date.now();
      transferStatus.textContent = `Sending ${outgoing.name}…`;
      sendJson({
        kind: 'file-start',
        id,
        name: outgoing.name,
        mime: outgoing.type,
        size: outgoing.size,
        sentAt
      });
      let sent = 0;
      while (sent < outgoing.size) {
        await waitForBufferSpace();
        const chunk = await outgoing.slice(sent, sent + CHUNK_SIZE).arrayBuffer();
        if (!canSend()) throw new Error('The peer disconnected during transfer.');
        channel.send(chunk);
        sent += chunk.byteLength;
        transferStatus.textContent = `Sending photo · ${Math.round(sent / outgoing.size * 100)}%`;
      }
      sendJson({ kind: 'file-end', id });
      appendImage(outgoing, outgoing.name, true, sentAt);
      transferStatus.textContent = `Photo sent · ${Math.max(1, Math.round(outgoing.size / 1024))} KB`;
    } finally {
      sendingFile = false;
      setExchangeEnabled(canSend());
      imageInput.value = '';
    }
  }

  async function endConversation() {
    if (canSend()) {
      try {
        sendJson({ kind: 'session-end', sentAt: Date.now() });
        await new Promise(resolve => setTimeout(resolve, 80));
      } catch {
        // The local disconnect still completes.
      }
    }
    sessionWasConnected = false;
    resetPeer();
    await releaseWakeLock();
    showStart();
  }

  function checkConnectionAfterResume() {
    if (!sessionWasConnected) return;
    if (canSend()) {
      try {
        lastPongAt = Date.now();
        sendJson({ kind: 'heartbeat-ping', sentAt: Date.now() });
        setStatus('Connected', 'connected', 'Checking that your friend is still reachable.');
      } catch {
        scheduleRecovery('The phone could not reach your friend.');
      }
      return;
    }
    scheduleRecovery('The phone was asleep or offline.');
  }

  connectStartButton.addEventListener('click', showRoleChoices);
  backToStartButton.addEventListener('click', () => {
    resetPeer();
    void releaseWakeLock();
    showStart();
  });
  createOfferButton.addEventListener('click', () => {
    void requestWakeLock();
    void createOffer();
  });
  scanQrButton.addEventListener('click', () => {
    void requestWakeLock();
    void startScanner();
  });
  scanReturnButton.addEventListener('click', startScanner);
  reconnectShowButton.addEventListener('click', () => {
    void requestWakeLock();
    void createOffer({ recovery: true });
  });
  reconnectScanButton.addEventListener('click', () => {
    void requestWakeLock();
    void startScanner();
  });
  closePairingButton.addEventListener('click', () => {
    pairingDismissed = true;
    hidePairing();
    if (chatView.hidden) {
      resetPeer();
      void releaseWakeLock();
      showRoleChoices();
    } else if (!canSend()) {
      showReconnectChoices('Reconnect when you are ready');
    }
  });
  pairingModal.addEventListener('click', event => {
    if (event.target === pairingModal) closePairingButton.click();
  });
  closeScannerButton.addEventListener('click', stopScanner);
  scannerModal.addEventListener('click', event => {
    if (event.target === scannerModal) stopScanner();
  });
  useCodeButton.addEventListener('click', () => useRemoteDescription());
  copyCode.addEventListener('click', copyLocalCode);
  wakeStatus.addEventListener('click', () => {
    if (wakeStatus.dataset.state === 'retry') void requestWakeLock();
  });
  resetButton.addEventListener('click', endConversation);
  clearHistoryButton.addEventListener('click', clearHistory);
  emojiToggle.addEventListener('click', () => {
    emojiPicker.hidden = !emojiPicker.hidden;
  });
  emojiPicker.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || messageInput.disabled) return;
    const emoji = button.textContent;
    const start = messageInput.selectionStart ?? messageInput.value.length;
    const end = messageInput.selectionEnd ?? start;
    messageInput.setRangeText(emoji, start, end, 'end');
    messageInput.focus({ preventScroll: true });
  });

  messageForm.addEventListener('submit', event => {
    event.preventDefault();
    const text = messageInput.value.trim();
    if (!text || !canSend()) return;
    const sentAt = Date.now();
    try {
      sendJson({ kind: 'message', text, sentAt });
      appendMessage(text, true, sentAt);
      messageInput.value = '';
      emojiPicker.hidden = true;
      messageInput.focus({ preventScroll: true });
    } catch (error) {
      showError(error);
    }
  });

  imageInput.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await sendImage(file);
    } catch (error) {
      transferStatus.textContent = error?.message || 'Image transfer failed';
    }
  });

  imageLabel.addEventListener('click', event => {
    if (imageInput.disabled) event.preventDefault();
  });

  document.addEventListener('pointerdown', event => {
    if (
      !emojiPicker.hidden &&
      !emojiPicker.contains(event.target) &&
      event.target !== emojiToggle
    ) {
      emojiPicker.hidden = true;
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !scannerModal.hidden) stopScanner();
    else if (event.key === 'Escape' && !pairingModal.hidden) closePairingButton.click();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (!scannerModal.hidden) stopScanner();
    } else {
      if (wakeLockWanted) void requestWakeLock();
      checkConnectionAfterResume();
    }
  });

  window.addEventListener('pageshow', event => {
    if (event.persisted) {
      if (wakeLockWanted) void requestWakeLock();
      checkConnectionAfterResume();
    }
  });

  window.addEventListener('online', checkConnectionAfterResume);
  window.visualViewport?.addEventListener('resize', () => {
    if (chatView.hidden) return;
    requestAnimationFrame(() => {
      messages.scrollTop = messages.scrollHeight;
    });
  });

  window.addEventListener('beforeunload', () => {
    stopScanner();
    stopHeartbeat();
    clearRecoveryTimer();
    void releaseWakeLock();
    channel?.close();
    peer?.close();
    objectUrls.forEach(url => URL.revokeObjectURL(url));
  });

  if (!('RTCPeerConnection' in window)) {
    setStatus('Not supported here', 'error', 'Try this page in a current version of Chrome, Safari, or Firefox.');
    connectStartButton.disabled = true;
    createOfferButton.disabled = true;
    scanQrButton.disabled = true;
    useCodeButton.disabled = true;
  } else {
    resetPeer();
    showStart();
  }
  void restoreHistory();
})();
