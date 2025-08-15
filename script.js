// Environment detection and conditional logging
const isDevelopment = () => {
  return location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1' ||
    location.hostname === '' ||
    location.protocol === 'file:';
};

const debugLog = (...args) => {
  if (isDevelopment()) {
    console.log(...args);
  }
};

const debugError = (...args) => {
  if (isDevelopment()) {
    console.error(...args);
  }
};

class JapaneseTTS {
  constructor() {
    this.audioBlob = null;
    this.initializeElements();
    this.bindEvents();
  }

  initializeElements() {
    this.textInput = document.getElementById('textInput');
    this.voiceSelect = document.getElementById('voiceSelect');
    this.generateBtn = document.getElementById('generateBtn');
    this.playBtn = document.getElementById('playBtn');
    this.downloadBtn = document.getElementById('downloadBtn');
    this.statusDiv = document.getElementById('statusDiv');
    this.audioSection = document.getElementById('audioSection');
    this.audioPlayer = document.getElementById('audioPlayer');
  }

  bindEvents() {
    this.generateBtn.addEventListener('click', () => this.generateAudio());
    this.playBtn.addEventListener('click', () => this.playAudio());
    this.downloadBtn.addEventListener('click', () => this.downloadAudio());

    // Example sentence click events
    document.querySelectorAll('.example-item').forEach(item => {
      item.addEventListener('click', () => {
        this.textInput.value = item.textContent;
      });
    });

    // Keyboard shortcut for Enter
    this.textInput.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'Enter') {
        this.generateAudio();
      }
    });
  }

  createSSML(text, voice) {
    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ja-JP">
            <voice name="${voice}">
                <prosody rate="medium" pitch="medium">${text}</prosody>
            </voice>
        </speak>`;
  }

  showStatus(message, type = 'loading') {
    this.statusDiv.innerHTML = `<div class="status ${type}">${message}</div>`;
  }

  hideStatus() {
    this.statusDiv.innerHTML = '';
  }

  generateRequestId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  generateTimestamp() {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  async generateAudio() {
    const text = this.textInput.value.trim();
    if (!text) {
      this.showStatus('请输入要转换的日语文本', 'error');
      return;
    }

    const voice = this.voiceSelect.value;

    this.generateBtn.disabled = true;
    this.showStatus('<span class="loader"></span> 正在生成音频，请稍候...', 'loading');

    try {
      await this.synthesizeSpeechWebSocket(text, voice);
    } catch (error) {
      debugError('Audio generation failed:', error);
      this.showStatus(`生成失败: ${error.message}`, 'error');
    } finally {
      this.generateBtn.disabled = false;
    }
  }

  async synthesizeSpeechWebSocket(text, voice) {
    return new Promise((resolve, reject) => {
      const requestId = this.generateRequestId();
      const timestamp = this.generateTimestamp();

      // WebSocket connection URL
      const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=${requestId}`;

      const ws = new WebSocket(wsUrl);
      const audioChunks = [];
      let hasError = false;

      ws.onopen = () => {
        debugLog('WebSocket connection established');

        // Send configuration message
        const configMessage = `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;
        ws.send(configMessage);

        // Send SSML message
        const ssml = this.createSSML(text, voice);
        const ssmlMessage = `X-RequestId:${requestId}\r\nX-Timestamp:${timestamp}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`;
        ws.send(ssmlMessage);
      };

      ws.onmessage = async (event) => {
        if (typeof event.data === 'string') {
          debugLog('Received text message:', event.data);

          if (event.data.includes('Path:turn.end')) {
            // Audio transmission completed
            debugLog('Audio transmission completed, received audio chunks:', audioChunks.length);
            ws.close();

            if (audioChunks.length > 0) {
              this.processAudioChunks(audioChunks);
              resolve();
            } else {
              reject(new Error('No audio data received'));
            }
          }
        } else if (event.data instanceof Blob) {
          // Handle Blob type binary data
          const arrayBuffer = await event.data.arrayBuffer();
          this.parseAudioMessage(arrayBuffer, audioChunks);
        } else if (event.data instanceof ArrayBuffer) {
          // Handle ArrayBuffer directly
          this.parseAudioMessage(event.data, audioChunks);
        } else {
          debugLog('Received unknown data type:', typeof event.data);
        }
      };

      ws.onerror = (error) => {
        debugError('WebSocket error:', error);
        hasError = true;
        reject(new Error('WebSocket connection error'));
      };

      ws.onclose = (event) => {
        debugLog('WebSocket connection closed:', event.code, event.reason);
        if (!hasError && audioChunks.length === 0) {
          reject(new Error('Connection closed unexpectedly, no audio data received'));
        }
      };

      // Set timeout
      setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
          ws.close();
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  parseAudioMessage(arrayBuffer, audioChunks) {
    try {
      debugLog('Parsing audio message, total size:', arrayBuffer.byteLength);

      // Check if there's enough data to read the header
      if (arrayBuffer.byteLength < 2) {
        debugLog('Data too small, skipping');
        return;
      }

      const dataView = new DataView(arrayBuffer);

      // Read header length (big-endian)
      const headerLength = dataView.getUint16(0, false);
      debugLog('Header length:', headerLength);

      // Validate header length
      if (headerLength >= arrayBuffer.byteLength) {
        debugLog('Header length abnormal, trying to read entire message as audio data');
        // Some messages may not have standard headers, treat as audio data directly
        if (arrayBuffer.byteLength > 100) { // Only treat as audio when data is large enough
          audioChunks.push(arrayBuffer);
          debugLog('Added entire message as audio chunk, size:', arrayBuffer.byteLength);
        }
        return;
      }

      // Read header content
      const headerBytes = new Uint8Array(arrayBuffer, 2, headerLength);
      const headerText = new TextDecoder('utf-8').decode(headerBytes);
      debugLog('Header content:', headerText);

      // Check if it's audio data
      if (headerText.includes('Path:audio') || headerText.includes('Content-Type:audio')) {
        const audioDataStart = 2 + headerLength;
        if (audioDataStart < arrayBuffer.byteLength) {
          const audioData = arrayBuffer.slice(audioDataStart);
          audioChunks.push(audioData);
          debugLog('Extracted audio data, size:', audioData.byteLength);
        }
      } else {
        debugLog('Non-audio message, skipping');
      }
    } catch (error) {
      debugError('Error parsing audio message:', error);
      // If parsing fails, try to treat entire data as audio (error tolerance)
      if (arrayBuffer.byteLength > 1000) { // Only if data is large enough to be audio
        audioChunks.push(arrayBuffer);
        debugLog('Parsing failed, treating entire message as audio chunk');
      }
    }
  }

  processAudioChunks(audioChunks) {
    debugLog('Starting to process audio chunks, total count:', audioChunks.length);

    // Merge all audio chunks
    const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    debugLog('Total audio size:', totalLength, 'bytes');

    if (totalLength === 0) {
      this.showStatus('未收到有效音频数据', 'error');
      return;
    }

    const combinedArray = new Uint8Array(totalLength);

    let offset = 0;
    for (const chunk of audioChunks) {
      const chunkArray = new Uint8Array(chunk);
      combinedArray.set(chunkArray, offset);
      offset += chunk.byteLength;
      debugLog('Merged audio chunk, offset:', offset);
    }

    // Validate MP3 header (MP3 files should start with 0xFF 0xFB or similar)
    if (combinedArray.length > 4) {
      const header = Array.from(combinedArray.slice(0, 4))
        .map(b => '0x' + b.toString(16).padStart(2, '0'))
        .join(' ');
      debugLog('Audio file header:', header);
    }

    // Create audio Blob
    this.audioBlob = new Blob([combinedArray], { type: 'audio/mpeg' });

    // Create audio URL and play
    const audioUrl = URL.createObjectURL(this.audioBlob);
    this.audioPlayer.src = audioUrl;

    // Show audio player
    this.audioSection.style.display = 'block';

    // Enable buttons
    this.playBtn.disabled = false;
    this.downloadBtn.disabled = false;

    this.showStatus('音频生成成功！', 'success');

    // Hide status after 3 seconds
    setTimeout(() => this.hideStatus(), 3000);

    debugLog('Audio processing completed, playable size:', this.audioBlob.size, 'bytes');
  }

  playAudio() {
    if (this.audioPlayer.src) {
      this.audioPlayer.play();
    }
  }

  downloadAudio() {
    if (!this.audioBlob) return;

    const text = this.textInput.value.trim();
    const cleanText = text.replace(/[^\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF\u3400-\u4DBF]/g, '').substring(0, 20);
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
    const filename = `japanese_tts_${cleanText || timestamp}.mp3`;

    const url = URL.createObjectURL(this.audioBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    this.showStatus(`已下载: ${filename}`, 'success');
    setTimeout(() => this.hideStatus(), 3000);
  }
}

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
  new JapaneseTTS();
});