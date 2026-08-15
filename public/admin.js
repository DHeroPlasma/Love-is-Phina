const socket = io();

const adminLogin = document.querySelector("#adminLogin");
const dashboard = document.querySelector("#dashboard");
const adminForm = document.querySelector("#adminForm");
const adminKeyInput = document.querySelector("#adminKeyInput");
const adminError = document.querySelector("#adminError");

let adminKey = sessionStorage.getItem("weddingQuizAdminKey") || "";
let questions = [];
let participants = [];
let game = null;

adminKeyInput.value = adminKey;

function loginAdmin() {
  if (!adminKey) return;

  socket.emit("admin:join", { key: adminKey }, (response) => {
    if (!response.ok) {
      adminError.textContent = response.error;
      adminLogin.classList.remove("hidden");
      dashboard.classList.add("hidden");
      return;
    }

    questions = response.questions;
    participants = response.participants;
    game = response.game;

    sessionStorage.setItem("weddingQuizAdminKey", adminKey);
    adminLogin.classList.add("hidden");
    dashboard.classList.remove("hidden");
    adminError.textContent = "";

    renderQuestions();
    renderParticipants();
    renderGame();
    loadJoinInfo();
  });
}

adminForm.addEventListener("submit", (event) => {
  event.preventDefault();
  adminKey = adminKeyInput.value;
  loginAdmin();
});

socket.on("connect", () => {
  document.querySelector("#connectionState").textContent = "verbunden";
  if (adminKey) loginAdmin();
});

socket.on("disconnect", () => {
  document.querySelector("#connectionState").textContent = "getrennt";
});

socket.on("participants:update", (nextParticipants) => {
  participants = nextParticipants;
  renderParticipants();
});

socket.on("game:update", (nextGame) => {
  game = nextGame;
  renderGame();
});

async function loadJoinInfo() {
  const response = await fetch("/api/join-info");
  const data = await response.json();

  document.querySelector("#qrCode").src = data.qrDataUrl;
  document.querySelector("#joinUrl").textContent = data.joinUrl;
}

function renderParticipants() {
  const element = document.querySelector("#participants");
  const count = document.querySelector("#participantCount");

  const connectedCount = participants.filter((p) => p.connected).length;
  count.textContent = `(${connectedCount}/${participants.length})`;

  if (!participants.length) {
    element.innerHTML = '<p class="muted">Noch niemand beigetreten.</p>';
    return;
  }

  const sorted = [...participants].sort((a, b) => b.score - a.score);

  element.innerHTML = sorted
    .map(
      (p) => `
        <div class="participant-row">
          <div>
            <strong>${escapeHtml(p.pseudonym)}</strong>
            <div class="muted small">${escapeHtml(p.realName)}</div>
          </div>
          <div class="participant-meta">
            <span>${p.score} P.</span>
            <span class="status-dot ${p.connected ? "online" : ""}"></span>
          </div>
        </div>
      `
    )
    .join("");
}

function renderQuestions() {
  const element = document.querySelector("#questionList");

  element.innerHTML = questions
    .map(
      (q, index) => `
        <button class="question-item" data-index="${index}" type="button">
          <span>Frage ${index + 1}</span>
          <strong>${escapeHtml(q.text)}</strong>
        </button>
      `
    )
    .join("");

  element.querySelectorAll(".question-item").forEach((button) => {
    button.addEventListener("click", () => {
      const questionIndex = Number(button.dataset.index);

      socket.emit(
        "admin:startQuestion",
        { key: adminKey, questionIndex },
        (response) => {
          if (!response.ok) alert(response.error);
        }
      );
    });
  });
}

function renderGame() {
  if (!game) return;

  const phaseLabels = {
    lobby: "Lobby",
    question: "Abstimmung läuft",
    reveal: "Aufgelöst",
    finished: "Beendet"
  };

  document.querySelector("#phaseBadge").textContent =
    phaseLabels[game.phase] || game.phase;

  document.querySelector("#answerCounter").textContent =
    game.phase === "question"
      ? `${game.answerTotal} Antwort${game.answerTotal === 1 ? "" : "en"}`
      : "";

  const empty = document.querySelector("#stageEmpty");
  const stage = document.querySelector("#stageQuestion");

  if (game.currentQuestionIndex === null) {
    empty.classList.remove("hidden");
    stage.classList.add("hidden");
    return;
  }

  empty.classList.add("hidden");
  stage.classList.remove("hidden");

  document.querySelector("#stageQuestionText").textContent = game.question.text;

  document.querySelector("#stageOptions").innerHTML = game.question.options
    .map(
      (option, index) => `
        <div class="stage-option">
          <span>${index === 0 ? "A" : "B"}</span>
          <strong>${escapeHtml(option)}</strong>
        </div>
      `
    )
    .join("");

  const results = document.querySelector("#stageResults");

  if (game.phase === "reveal") {
    const counts = game.answerCounts || [0, 0];
    const total = Math.max(1, counts[0] + counts[1]);

    results.innerHTML = game.question.options
      .map((option, index) => {
        const percent = Math.round((counts[index] / total) * 100);
        const isCorrect = game.question.correctOption === index;

        return `
          <div class="result ${isCorrect ? "correct" : ""}">
            <div class="result-label">
              <span>${escapeHtml(option)}${isCorrect ? " ✓" : ""}</span>
              <strong>${counts[index]} · ${percent}%</strong>
            </div>
            <div class="bar"><div class="bar-fill" style="width:${percent}%"></div></div>
          </div>
        `;
      })
      .join("");
  } else {
    results.innerHTML = "";
  }

  document.querySelector("#revealButton").disabled =
    game.phase !== "question";
}

document.querySelector("#revealButton").addEventListener("click", () => {
  socket.emit("admin:reveal", { key: adminKey }, (response) => {
    if (!response.ok) alert(response.error);
  });
});

document.querySelector("#finishButton").addEventListener("click", () => {
  socket.emit("admin:finish", { key: adminKey }, (response) => {
    if (!response.ok) alert(response.error);
  });
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
