let model, webcam;
const video = document.getElementById('webcam');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const labelEl = document.getElementById('detected-object');
const distanceEl = document.getElementById('distance');
const actionEl = document.getElementById('action');

const FOV = 60 * Math.PI / 180;
let previousAction = "";

function speak(text) {
  const synth = window.speechSynthesis;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "ko-KR";
  synth.cancel();
  synth.speak(utter);
}

async function setupCamera() {
  webcam = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480 },
    audio: false
  });
  video.srcObject = webcam;
  return new Promise((resolve) => {
    video.onloadedmetadata = () => resolve(video);
  });
}

function estimateDistanceMeters(bbox, videoWidth) {
  const REAL_WIDTH = 0.5;
  const bboxWidth = bbox[2];
  if (bboxWidth <= 0) return '-';
  const distance = (REAL_WIDTH * videoWidth) / (2 * Math.tan(FOV / 2) * bboxWidth);
  return parseFloat(distance.toFixed(2));
}

function expandBBox(bbox, scale, canvasWidth, canvasHeight) {
  let [x, y, w, h] = bbox;
  const centerX = x + w / 2;
  const centerY = y + h / 2;

  w *= scale;
  h *= scale;

  x = centerX - w / 2;
  y = centerY - h / 2;

  x = Math.max(0, Math.floor(x));
  y = Math.max(0, Math.floor(y));
  w = Math.min(canvasWidth - x, Math.floor(w));
  h = Math.min(canvasHeight - y, Math.floor(h));

  return [x, y, w, h];
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  let max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, v = max;
  let d = max - min;
  s = max === 0 ? 0 : d / max;
  if (max === min) h = 0;
  else {
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = ((b - r) / d + 2); break;
      case b: h = ((r - g) / d + 4); break;
    }
    h /= 6;
  }
  return [h * 360, s, v];
}

function classifyTrafficLightColorByRegion(bbox, ctx) {
  const [x, y, w, h] = expandBBox(bbox, 1.5, canvas.width, canvas.height);

  const thirdH = Math.floor(h / 3);
  const regions = [
    [x, y, w, thirdH],           // 상단 (빨강)
    [x, y + thirdH, w, thirdH],  // 중간 (노랑)
    [x, y + 2 * thirdH, w, thirdH] // 하단 (초록)
  ];

  const colorNames = ['red', 'yellow', 'green'];
  let counts = { red: 0, yellow: 0, green: 0 };

  for (let i = 0; i < 3; i++) {
    const [rx, ry, rw, rh] = regions[i];
    if (rw <= 0 || rh <= 0) continue;
    try {
      const data = ctx.getImageData(rx, ry, rw, rh).data;
      for (let j = 0; j < data.length; j += 4) {
        const r = data[j], g = data[j + 1], b = data[j + 2];
        const [h, s, v] = rgbToHsv(r, g, b);
        if (v < 0.2) continue; // 너무 어두운 픽셀 무시
        // 빨강 범위
        if ((h >= 340 || h <= 20) && s > 0.5 && v > 0.3) counts.red++;
        // 노랑 범위
        else if (h >= 20 && h <= 70 && s > 0.5 && v > 0.3) counts.yellow++;
        // 초록 범위
        else if (h >= 70 && h <= 160 && s > 0.3 && v > 0.2) counts.green++;
      }
    } catch (e) {
      console.warn('getImageData 오류:', e);
    }
    // 디버그용 사각형 그리기
    ctx.strokeStyle = colorNames[i];
    ctx.lineWidth = 2;
    ctx.strokeRect(rx, ry, rw, rh);
  }

  // 가장 많이 나온 색상 찾기
  let maxColor = 'red';
  let maxCount = counts.red;
  for (const c of ['yellow', 'green']) {
    if (counts[c] > maxCount) {
      maxCount = counts[c];
      maxColor = c;
    }
  }

  return maxColor;
}

async function detectFrame() {
  // 캔버스 크기와 비디오 크기 강제 일치
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.style.width = `${video.videoWidth}px`;
  canvas.style.height = `${video.videoHeight}px`;

  // 영상 캔버스에 그리기 (중요!)
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const predictions = await model.detect(video);

  // 감지 박스 초기화 (투명 배경으로 덮기)
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  let action = "서행";
  let distanceText = "-";
  let speechText = "";

  let stopDetected = false;
  let greenLight = false;
  let redOrYellowLight = false;

  let detectedObjects = [];

  for (const pred of predictions) {
    const { class: label, bbox, score } = pred;
    if (score < 0.5) continue;

    // 다시 비디오 그리기 (박스 뒤에 영상 있어야 색상 인식됨)
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = "#00ffff";
    ctx.lineWidth = 2;
    ctx.strokeRect(...bbox);
    ctx.fillStyle = "#00ffff";
    ctx.font = "16px 'Segoe UI'";
    ctx.fillText(label, bbox[0], bbox[1] > 10 ? bbox[1] - 5 : 10);

    const distance = estimateDistanceMeters(bbox, video.videoWidth);
    const distanceStr = distance !== '-' ? `${distance}m` : '-';

    if (["person", "cat", "dog", "horse", "sheep", "cow"].includes(label)) {
      if (distance !== '-' && distance <= 5.0) {
        stopDetected = true;
        distanceText = `${distance} m`;
      }
      detectedObjects.push(`${label} (${distanceStr})`);
    } else if (label === "traffic light") {
      const color = classifyTrafficLightColorByRegion(bbox, ctx);
      let colorShort = 'R';
      if (color === 'green') {
        greenLight = true;
        colorShort = 'G';
      } else if (color === 'yellow') {
        redOrYellowLight = true;
        colorShort = 'Y';
      } else if (color === 'red') {
        redOrYellowLight = true;
        colorShort = 'R';
      }
      detectedObjects.push(`신호등 - ${colorShort}`);
    } else {
      detectedObjects.push(`${label} (${distanceStr})`);
    }
  }

  if (stopDetected || redOrYellowLight) {
    action = "정지";
    speechText = "정지하십시오";
  } else if (greenLight) {
    action = "서행";
    speechText = "서행하십시오";
  }

  if (action !== previousAction) {
    speak(speechText);
    previousAction = action;
  }

  labelEl.textContent = `인식된 객체: ${detectedObjects.length > 0 ? detectedObjects.join(', ') : '없음'}`;
  distanceEl.textContent = `예상 거리: ${distanceText}`;
  actionEl.textContent = `상태: ${action}`;

  requestAnimationFrame(detectFrame);
}

async function main() {
  await setupCamera();
  model = await cocoSsd.load();
  detectFrame();
}

main();
