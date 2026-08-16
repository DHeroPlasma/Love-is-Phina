const socket = io();


/* -------------------------------------------------------------------------- */
/* DOM references                                                             */
/* -------------------------------------------------------------------------- */

const loginCard =
  document.querySelector("#loginCard");

const gameCard =
  document.querySelector("#gameCard");

const joinForm =
  document.querySelector("#joinForm");

const realNameInput =
  document.querySelector("#realName");

const pseudonymInput =
  document.querySelector("#pseudonym");

const loginError =
  document.querySelector("#loginError");

const playerName =
  document.querySelector("#playerName");

const progress =
  document.querySelector("#progress");


/* -------------------------------------------------------------------------- */
/* Game views                                                                 */
/* -------------------------------------------------------------------------- */

const views = {
  lobby:
    document.querySelector(
      "#lobbyView"
    ),

  question:
    document.querySelector(
      "#questionView"
    ),

  reveal:
    document.querySelector(
      "#revealView"
    ),

  finished:
    document.querySelector(
      "#finishedView"
    )
};


/* -------------------------------------------------------------------------- */
/* Client ID                                                                  */
/* -------------------------------------------------------------------------- */

/*
  Every browser receives its own clientId.

  The ID is stored in localStorage so that the server can recognize
  the participant again after:

  - reconnecting to Wi-Fi
  - refreshing the page
  - restarting the Node.js server
  - recovering a saved game state
*/

let clientId =
  localStorage.getItem(
    "weddingQuizClientId"
  );


if (!clientId) {

  /*
    crypto.randomUUID() is not available in every mobile browser
    when the website is accessed through an unencrypted local
    HTTP connection.

    Therefore we use a fallback ID if randomUUID() is unavailable.
  */

  clientId =
    (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    )
      ? crypto.randomUUID()
      : `guest-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}`;

  localStorage.setItem(
    "weddingQuizClientId",
    clientId
  );
}


/* -------------------------------------------------------------------------- */
/* Saved participant profile                                                  */
/* -------------------------------------------------------------------------- */

let savedProfile = null;

try {

  savedProfile =
    JSON.parse(
      localStorage.getItem(
        "weddingQuizProfile"
      ) || "null"
    );

} catch (error) {

  console.warn(
    "Stored participant profile could not be read.",
    error
  );

  savedProfile = null;
}


/*
  If a profile exists, pre-fill the registration form.

  This is useful if the guest temporarily loses connection
  and the page reloads.
*/

if (savedProfile) {

  realNameInput.value =
    savedProfile.realName || "";

  pseudonymInput.value =
    savedProfile.pseudonym || "";
}


/* -------------------------------------------------------------------------- */
/* View handling                                                              */
/* -------------------------------------------------------------------------- */

function showView(name) {

  Object.entries(
    views
  ).forEach(
    ([key, element]) => {

      element.classList.toggle(
        "hidden",
        key !== name
      );
    }
  );
}


/* -------------------------------------------------------------------------- */
/* Main game rendering                                                        */
/* -------------------------------------------------------------------------- */

function renderGame(state) {

  if (!state) {
    return;
  }


  /* ------------------------------------------------------------------------ */
  /* Progress                                                                 */
  /* ------------------------------------------------------------------------ */

  progress.textContent =
    state.currentQuestionIndex === null
      ? state.roundLabel || ""
      : `Frage ${
          state.currentQuestionIndex + 1
        } / ${
          state.totalQuestions
        }`;


  /* ------------------------------------------------------------------------ */
  /* Finished                                                                 */
  /* ------------------------------------------------------------------------ */

  if (
    state.phase === "finished"
  ) {

    showView(
      "finished"
    );

    return;
  }


  /* ------------------------------------------------------------------------ */
  /* Matching / waiting between rounds                                        */
  /* ------------------------------------------------------------------------ */

  if (
    state.phase === "matching" ||
    state.phase === "round2_ready" ||
    state.phase === "lobby"
  ) {

    showView(
      "lobby"
    );

    const lobbyView =
      document.querySelector(
        "#lobbyView"
      );

    /*
      During Round 2, show the participant's partner
      if one exists.
    */

    if (
      state.round === 2 &&
      state.partner
    ) {

      lobbyView.innerHTML = `
        <p class="eyebrow">
          Pärchenrunde ♥
        </p>

        <h2>
          Dein Match steht fest!
        </h2>

        <p>
          Du spielst jetzt gemeinsam mit
          <strong>
            ${escapeHtml(
              state.partner.realName
            )}
          </strong>.
        </p>

        <p class="muted">
          Wartet auf die nächste Frage.
        </p>
      `;

      return;
    }


    /*
      A participant may remain unmatched when the total
      number of guests is odd.
    */

    if (
      state.round === 2 &&
      state.isUnmatched
    ) {

      lobbyView.innerHTML = `
        <p class="eyebrow">
          Pärchenrunde ♥
        </p>

        <h2>
          Du bist diesmal Zuschauer.
        </h2>

        <p>
          Bei einer ungeraden Teilnehmerzahl
          bleibt leider eine Person ohne Zweier-Match.
        </p>

        <p class="muted">
          Du kannst die Pärchenrunde natürlich
          weiterhin mitverfolgen.
        </p>
      `;

      return;
    }


    /*
      Matching screen shown after Round 1.
    */

    if (
      state.phase === "matching"
    ) {

      lobbyView.innerHTML = `
        <p class="eyebrow">
          It's a Match ♥
        </p>

        <h2>
          Die Findungsrunde ist vorbei!
        </h2>

        <p>
          Eure Antworten werden gerade
          miteinander verglichen.
        </p>

        <p class="muted">
          Gleich erfährst du, mit wem du
          in die Pärchenrunde gehst.
        </p>
      `;

      return;
    }


    /*
      Default lobby for Round 1.
    */

    lobbyView.innerHTML = `
      <p class="eyebrow">
        You are in ♥
      </p>

      <h2>
        Du bist dabei!
      </h2>

      <p>
        Warte, bis die nächste Frage
        auf deinem Smartphone erscheint.
      </p>
    `;

    return;
  }


  /* ------------------------------------------------------------------------ */
  /* Question                                                                 */
  /* ------------------------------------------------------------------------ */

  if (
    state.phase === "question"
  ) {

    showView(
      "question"
    );

    const questionText =
      document.querySelector(
        "#questionText"
      );

    const options =
      document.querySelector(
        "#options"
      );

    const status =
      document.querySelector(
        "#answerStatus"
      );


    questionText.textContent =
      state.question?.text || "";


    /*
      An unmatched guest cannot answer during Round 2.
    */

    if (
      state.round === 2 &&
      state.isUnmatched
    ) {

      options.innerHTML = "";

      status.textContent =
        "Du verfolgst diese Runde als Zuschauer.";

      return;
    }


    options.innerHTML = "";


    /*
      Create one answer button for each option.
    */

    state.question.options.forEach(
      (
        option,
        optionIndex
      ) => {

        const button =
          document.createElement(
            "button"
          );

        button.type =
          "button";

        button.className =
          "answer-button";

        button.textContent =
          option;


        /*
          Highlight the previously selected answer
          after reconnecting or re-rendering.
        */

        if (
          state.ownAnswer ===
          optionIndex
        ) {

          button.classList.add(
            "selected"
          );
        }


        button.addEventListener(
          "click",
          () => {

            /*
              Prevent rapid double-clicks while the request
              is being sent.
            */

            button.disabled =
              true;


            socket.emit(
              "participant:answer",
              {
                optionIndex
              },
              (response) => {

                button.disabled =
                  false;


                if (
                  !response ||
                  !response.ok
                ) {

                  status.textContent =
                    response?.error ||
                    "Antwort konnte nicht gespeichert werden.";

                  return;
                }


                /*
                  Remove the selected state from all buttons
                  and apply it to the newly selected answer.
                */

                [...options.children]
                  .forEach(
                    (
                      child,
                      index
                    ) => {

                      child.classList.toggle(
                        "selected",
                        index ===
                          optionIndex
                      );
                    }
                  );


                status.textContent =
                  "Antwort gespeichert ✓";
              }
            );
          }
        );


        options.appendChild(
          button
        );
      }
    );


    /*
      Tell the user whether an answer has already
      been stored.
    */

    status.textContent =
      state.ownAnswer === null
        ? "Du kannst deine Auswahl bis zur Auflösung noch ändern."
        : "Antwort gespeichert ✓";

    return;
  }


  /* ------------------------------------------------------------------------ */
  /* Reveal                                                                   */
  /* ------------------------------------------------------------------------ */

  if (
    state.phase === "reveal"
  ) {

    showView(
      "reveal"
    );


    const revealQuestion =
      document.querySelector(
        "#revealQuestion"
      );

    const resultBars =
      document.querySelector(
        "#resultBars"
      );

    const additionalInfo =
      document.querySelector(
        "#correctAnswer"
      );


    revealQuestion.textContent =
      state.question?.text || "";


    const counts =
      state.answerCounts ||
      [0, 0];


    const total =
      Math.max(
        1,
        counts[0] +
        counts[1]
      );


    resultBars.innerHTML =
      state.question.options
        .map(
          (
            option,
            index
          ) => {

            const percent =
              Math.round(
                (
                  counts[index] /
                  total
                ) * 100
              );


            return `
              <div class="result">

                <div class="result-label">

                  <span>
                    ${escapeHtml(
                      option
                    )}
                  </span>

                  <strong>
                    ${counts[index]}
                    ·
                    ${percent}%
                  </strong>

                </div>

                <div class="bar">

                  <div
                    class="bar-fill"
                    style="
                      width:
                      ${percent}%
                    "
                  ></div>

                </div>

              </div>
            `;
          }
        )
        .join("");


    /*
      There are no objectively correct answers in the
      current version of the game, so this field remains empty.
    */

    additionalInfo.textContent = "";

    return;
  }
}


/* -------------------------------------------------------------------------- */
/* Join game                                                                  */
/* -------------------------------------------------------------------------- */

function joinGame(profile) {

  loginError.textContent = "";


  socket.emit(
    "participant:join",
    {
      clientId,
      realName:
        profile.realName,

      pseudonym:
        profile.pseudonym
    },
    (response) => {

      if (
        !response ||
        !response.ok
      ) {

        loginError.textContent =
          response?.error ||
          "Verbindung zum Spiel konnte nicht hergestellt werden.";


        loginCard.classList.remove(
          "hidden"
        );

        gameCard.classList.add(
          "hidden"
        );

        return;
      }


      /*
        Store the participant profile locally so the guest
        can automatically reconnect later.
      */

      savedProfile =
        profile;


      localStorage.setItem(
        "weddingQuizProfile",
        JSON.stringify(
          profile
        )
      );


      playerName.textContent =
        response.participant.pseudonym;


      loginCard.classList.add(
        "hidden"
      );

      gameCard.classList.remove(
        "hidden"
      );


      loginError.textContent = "";


      renderGame(
        response.game
      );
    }
  );
}


/* -------------------------------------------------------------------------- */
/* Registration form                                                          */
/* -------------------------------------------------------------------------- */

joinForm.addEventListener(
  "submit",
  (event) => {

    /*
      Prevent the browser from performing a normal HTML
      form submission and reloading the page.
    */

    event.preventDefault();


    const realName =
      realNameInput.value.trim();

    const pseudonym =
      pseudonymInput.value.trim();


    if (
      !realName ||
      !pseudonym
    ) {

      loginError.textContent =
        "Bitte fülle beide Felder aus.";

      return;
    }


    joinGame({
      realName,
      pseudonym
    });
  }
);


/* -------------------------------------------------------------------------- */
/* Socket reconnect                                                           */
/* -------------------------------------------------------------------------- */

socket.on(
  "connect",
  () => {

    /*
      If the browser already knows the participant profile,
      automatically reconnect to the existing game session.
    */

    if (savedProfile) {

      joinGame(
        savedProfile
      );
    }
  }
);


/* -------------------------------------------------------------------------- */
/* Live game updates                                                          */
/* -------------------------------------------------------------------------- */

socket.on(
  "game:update",
  (state) => {

    renderGame(
      state
    );
  }
);


/* -------------------------------------------------------------------------- */
/* Complete game reset                                                        */
/* -------------------------------------------------------------------------- */

/*
  The host can reset the entire game from the admin interface.

  When the server performs a reset, it broadcasts "game:reset"
  to every connected guest.

  We deliberately remove BOTH:

  - weddingQuizClientId
  - weddingQuizProfile

  This ensures that the browser is treated as a completely
  new participant after reloading.

  Without deleting the profile, the guest would immediately
  reconnect using their old name and pseudonym.
*/

socket.on(
  "game:reset",
  () => {

    localStorage.removeItem(
      "weddingQuizClientId"
    );

    localStorage.removeItem(
      "weddingQuizProfile"
    );


    /*
      Also clear the in-memory values.

      This is mainly useful for clarity because the page
      will immediately reload afterwards.
    */

    clientId = null;
    savedProfile = null;


    /*
      Reload the page.

      After the reload:
      - no clientId exists
      - no saved profile exists
      - a new clientId is generated
      - the registration screen is displayed
    */

    window.location.reload();
  }
);


/* -------------------------------------------------------------------------- */
/* HTML escaping                                                              */
/* -------------------------------------------------------------------------- */

/*
  Some values originate from user input, such as pseudonyms.

  Before inserting those values into innerHTML, they are escaped
  so that HTML entered by a participant is displayed as text
  instead of being interpreted by the browser.
*/

function escapeHtml(value) {

  return String(
    value ?? ""
  )
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );
}