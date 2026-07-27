(() => {
  'use strict';

  const MAX_FILE_SIZE = 5 * 1024 * 1024;
  const CHUNK_SIZE = 16 * 1024;
  const BUFFER_LIMIT = 512 * 1024;
  const HEARTBEAT_INTERVAL = 5000;
  const HEARTBEAT_TIMEOUT = 16000;
  const RECOVERY_GRACE = 12000;
  const CODE_PREFIX = 'water-webrtc-v2.';
  const LEGACY_CODE_PREFIX = 'water-webrtc-v1.';
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
  const pathLabel = $('#pathLabel');
  const reconnectNotice = $('#reconnectNotice');
  const reconnectText = $('#reconnectText');
  const reconnectScanButton = $('#reconnectScan');
  const messageForm = $('#messageForm');
  const messageInput = $('#messageInput');
  const sendMessageButton = $('#sendMessage');
  const imageInput = $('#imageInput');
  const imageLabel = $('#imageLabel');
  const transferStatus = $('#transferStatus');
  const messages = $('#messages');
  const emptyState = $('#emptyState');

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
  let connectionOwner = null;
  let recoveryOfferInProgress = false;
  const objectUrls = new Set();

  function setStatus(text, state = 'idle', detail) {
    statusText.textContent = text;
    statusPill.dataset.state = state;
    statusPill.hidden = false;
    if (detail) connectionDetail.textContent = detail;
  }

  function showStart() {
    setupView.hidden = false;
    startView.hidden = false;
    roleView.hidden = true;
    chatView.hidden = true;
    reconnectNotice.hidden = true;
    hidePairing();
    statusPill.hidden = true;
  }

  function showRoleChoices() {
    setupView.hidden = false;
    startView.hidden = true;
    roleView.hidden = false;
    chatView.hidden = true;
    reconnectNotice.hidden = true;
    hidePairing();
    statusPill.hidden = true;
  }

  function showPairing() {
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
    statusPill.hidden = false;
  }

  function setExchangeEnabled(enabled) {
    messageInput.disabled = !enabled;
    sendMessageButton.disabled = !enabled;
    imageInput.disabled = !enabled || sendingFile;
    imageLabel.setAttribute('aria-disabled', String(!enabled || sendingFile));
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
    qrPanel.hidden = true;
    showChat();
    setStatus(
      'Connected',
      'connected',
      'Your private chat is ready.'
    );
    setExchangeEnabled(true);
    startHeartbeat();
    inspectConnectionPath();
  }

  function scheduleRecovery(reason) {
    if (recoveryTimer || recoveryOfferInProgress) return;
    setExchangeEnabled(false);
    setStatus('Reconnecting…', 'working', `${reason} Waiting briefly for WebRTC to recover the route.`);
    pathLabel.textContent = 'Checking connection';
    recoveryTimer = setTimeout(beginStaticRecovery, RECOVERY_GRACE);
  }

  async function beginStaticRecovery() {
    clearRecoveryTimer();
    stopHeartbeat();
    setExchangeEnabled(false);

    if (connectionOwner === true) {
      if (recoveryOfferInProgress) return;
      recoveryOfferInProgress = true;
      reconnectNotice.hidden = false;
      reconnectText.textContent = 'Show a fresh code to reconnect.';
      reconnectScanButton.textContent = 'Show code';
      setStatus('New scan needed', 'working', 'Show this fresh code to your friend.');
      await createOffer({ recovery: true });
      recoveryOfferInProgress = false;
      return;
    }

    reconnectNotice.hidden = false;
    reconnectText.textContent = 'Scan the fresh code on your friend’s phone.';
    reconnectScanButton.textContent = 'Scan code';
    pathLabel.textContent = 'Waiting for a fresh scan';
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

  async function inspectConnectionPath() {
    if (!peer) return;
    try {
      const stats = await peer.getStats();
      let pair = null;
      stats.forEach(report => {
        if (
          report.type === 'candidate-pair' &&
          report.state === 'succeeded' &&
          (report.nominated || report.selected)
        ) pair = report;
      });
      if (!pair) return;
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      const types = [local?.candidateType, remote?.candidateType].filter(Boolean);
      const relayed = types.includes('relay');
      pathLabel.textContent = relayed ? 'Private connection' : 'Direct phone-to-phone';
    } catch {
      pathLabel.textContent = 'Private connection';
    }
  }

  function resetPeer({ clearMessages = false, forgetSession = false } = {}) {
    stopScanner();
    stopHeartbeat();
    clearRecoveryTimer();
    const previousChannel = channel;
    const previousPeer = peer;
    peer = null;
    channel = null;
    role = null;
    if (forgetSession) {
      connectionOwner = null;
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
    reconnectNotice.hidden = true;
    transferStatus.textContent = '';
    pathLabel.textContent = 'Direct connection';
    setExchangeEnabled(false);
    setStatus('Not connected', 'idle', 'Both phones should keep this page open while connecting.');

    if (clearMessages) {
      messages.replaceChildren(emptyState);
      emptyState.hidden = false;
    }
  }

  async function createOffer({ recovery = false } = {}) {
    resetPeer();
    if (!recovery) connectionOwner = true;
    createOfferButton.disabled = true;
    useCodeButton.disabled = true;
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
        setStatus('Reconnect setup failed', 'error', error?.message || 'Could not create a fresh QR.');
      } else {
        showError(error);
      }
    } finally {
      createOfferButton.disabled = false;
      useCodeButton.disabled = false;
    }
  }

  async function useRemoteDescription(code = remoteCode.value) {
    useCodeButton.disabled = true;
    try {
      const description = await unpackDescription(typeof code === 'string' ? code : remoteCode.value);

      if (description.type === 'offer') {
        const reconnecting = connectionOwner !== null;
        if (connectionOwner === null) connectionOwner = false;
        resetPeer();
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

  function appendMessage(text, mine, timestamp = Date.now()) {
    emptyState.hidden = true;
    const item = document.createElement('div');
    item.className = `message${mine ? ' mine' : ''}`;
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
  }

  function appendImage(blob, name, mine) {
    emptyState.hidden = true;
    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    const item = document.createElement('div');
    item.className = `message image-message${mine ? ' mine' : ''}`;
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

      if (payload.kind === 'message' && typeof payload.text === 'string') {
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
        appendImage(blob, incomingFile.name, false);
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

  async function sendImage(file) {
    if (!canSend()) throw new Error('Connect a peer before sending an image.');
    if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
    if (file.size > MAX_FILE_SIZE) throw new Error('For this POC, images must be 5 MB or smaller.');

    sendingFile = true;
    setExchangeEnabled(true);
    const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    transferStatus.textContent = `Sending ${file.name}…`;
    sendJson({ kind: 'file-start', id, name: file.name, mime: file.type, size: file.size });

    try {
      let sent = 0;
      while (sent < file.size) {
        await waitForBufferSpace();
        const chunk = await file.slice(sent, sent + CHUNK_SIZE).arrayBuffer();
        if (!canSend()) throw new Error('The peer disconnected during transfer.');
        channel.send(chunk);
        sent += chunk.byteLength;
        transferStatus.textContent = `Sending ${file.name} · ${Math.round(sent / file.size * 100)}%`;
      }
      sendJson({ kind: 'file-end', id });
      appendImage(file, file.name, true);
      transferStatus.textContent = `Sent ${file.name}`;
    } finally {
      sendingFile = false;
      setExchangeEnabled(canSend());
      imageInput.value = '';
    }
  }

  connectStartButton.addEventListener('click', showRoleChoices);
  backToStartButton.addEventListener('click', () => {
    resetPeer({ forgetSession: true });
    showStart();
  });
  createOfferButton.addEventListener('click', () => createOffer());
  scanQrButton.addEventListener('click', startScanner);
  scanReturnButton.addEventListener('click', startScanner);
  reconnectScanButton.addEventListener('click', () => {
    if (connectionOwner === true && localCode.value) {
      showPairing();
    } else {
      void startScanner();
    }
  });
  closePairingButton.addEventListener('click', () => {
    hidePairing();
    if (chatView.hidden) {
      resetPeer({ forgetSession: true });
      showRoleChoices();
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
  resetButton.addEventListener('click', () => {
    resetPeer({ clearMessages: true, forgetSession: true });
    showStart();
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
      messageInput.focus();
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

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !scannerModal.hidden) stopScanner();
    else if (event.key === 'Escape' && !pairingModal.hidden) closePairingButton.click();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !scannerModal.hidden) stopScanner();
  });

  window.addEventListener('beforeunload', () => {
    stopScanner();
    stopHeartbeat();
    clearRecoveryTimer();
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
    resetPeer({ forgetSession: true });
    showStart();
  }
})();
