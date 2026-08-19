const { io } = require("socket.io-client");

/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

const SERVER_URL =
  process.env.LOAD_TEST_URL ||
  "http://localhost:3000";

const CLIENT_COUNT =
  Number(process.env.LOAD_TEST_CLIENTS || 50);

const MIN_ANSWER_DELAY_MS = 300;
const MAX_ANSWER_DELAY_MS = 2500;

const clients = [];

let connectedCount = 0;
let joinedCount = 0;
let answeredCount = 0;


/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function randomBetween(min, max) {
  return Math.floor(
    Math.random() * (max - min + 1)
  ) + min;
}

function randomOption() {
  return Math.random() < 0.5
    ? 0
    : 1;
}

function createProfile(index) {
  return {
    clientId: `loadtest-${Date.now()}-${index}`,
    realName: `Testperson ${index + 1}`,
    pseudonym: `LoveBot ${index + 1}`
  };
}

function logStatus() {
  console.log(
    `[STATUS] Connected: ${connectedCount}/${CLIENT_COUNT} | ` +
    `Joined: ${joinedCount}/${CLIENT_COUNT}`
  );
}


/*
|--------------------------------------------------------------------------
| Create simulated guests
|--------------------------------------------------------------------------
*/

for (
  let index = 0;
  index < CLIENT_COUNT;
  index++
) {
  createClient(index);
}


/*
|--------------------------------------------------------------------------
| Client
|--------------------------------------------------------------------------
*/

function createClient(index) {
  const profile =
    createProfile(index);

  const socket =
    io(SERVER_URL, {
      transports: [
        "websocket",
        "polling"
      ],

      reconnection: true,

      reconnectionAttempts:
        Infinity,

      reconnectionDelay:
        500,

      timeout:
        10000
    });

  const client = {
    index,
    profile,
    socket,
    lastAnsweredQuestionKey:
      null
  };

  clients.push(client);


  /*
  |--------------------------------------------------------------------------
  | Connection
  |--------------------------------------------------------------------------
  */

  socket.on(
    "connect",
    () => {
      connectedCount++;

      console.log(
        `[${profile.pseudonym}] connected (${socket.id})`
      );

      joinGame(client);

      logStatus();
    }
  );


  /*
  |--------------------------------------------------------------------------
  | Disconnect
  |--------------------------------------------------------------------------
  */

  socket.on(
    "disconnect",
    (reason) => {
      connectedCount =
        Math.max(
          0,
          connectedCount - 1
        );

      console.log(
        `[${profile.pseudonym}] disconnected: ${reason}`
      );
    }
  );


  /*
  |--------------------------------------------------------------------------
  | Connection errors
  |--------------------------------------------------------------------------
  */

  socket.on(
    "connect_error",
    (error) => {
      console.error(
        `[${profile.pseudonym}] connection error:`,
        error.message
      );
    }
  );


  /*
  |--------------------------------------------------------------------------
  | Game updates
  |--------------------------------------------------------------------------
  */

  socket.on(
    "game:update",
    (state) => {
      handleGameUpdate(
        client,
        state
      );
    }
  );


  /*
  |--------------------------------------------------------------------------
  | Reset
  |--------------------------------------------------------------------------
  */

  socket.on(
    "game:reset",
    () => {
      console.log(
        `[${profile.pseudonym}] game reset received`
      );

      client.lastAnsweredQuestionKey =
        null;

      /*
        Rejoin automatically after reset.

        For load testing this is more convenient than
        simulating a full browser reload.
      */

      setTimeout(
        () => {
          joinGame(client);
        },
        randomBetween(
          200,
          1500
        )
      );
    }
  );
}


/*
|--------------------------------------------------------------------------
| Join game
|--------------------------------------------------------------------------
*/

function joinGame(client) {
  const {
    socket,
    profile
  } = client;

  socket.emit(
    "participant:join",
    {
      clientId:
        profile.clientId,

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
        console.error(
          `[${profile.pseudonym}] join failed:`,
          response?.error
        );

        return;
      }

      joinedCount++;

      console.log(
        `[${profile.pseudonym}] joined`
      );

      if (response.game) {
        handleGameUpdate(
          client,
          response.game
        );
      }

      logStatus();
    }
  );
}


/*
|--------------------------------------------------------------------------
| React to active questions
|--------------------------------------------------------------------------
*/

function handleGameUpdate(
  client,
  state
) {
  if (!state) {
    return;
  }

  if (
    state.phase !==
      "question" ||
    state.currentQuestionIndex ===
      null
  ) {
    return;
  }


  /*
    Create a key that uniquely identifies
    the current round/question.
  */

  const questionKey =
    `${state.round}-${state.currentQuestionIndex}`;


  /*
    Avoid answering the same question repeatedly
    because game:update can be emitted many times.
  */

  if (
    client.lastAnsweredQuestionKey ===
    questionKey
  ) {
    return;
  }

  client.lastAnsweredQuestionKey =
    questionKey;


  /*
    Simulate a human response delay.
  */

  const delay =
    randomBetween(
      MIN_ANSWER_DELAY_MS,
      MAX_ANSWER_DELAY_MS
    );


  setTimeout(
    () => {
      answerQuestion(
        client,
        state
      );
    },
    delay
  );
}


/*
|--------------------------------------------------------------------------
| Submit answer
|--------------------------------------------------------------------------
*/

function answerQuestion(
  client,
  state
) {
  const {
    socket,
    profile
  } = client;

  if (!socket.connected) {
    return;
  }

  const optionIndex =
    randomOption();


  socket.emit(
    "participant:answer",
    {
      optionIndex
    },
    (response) => {
      if (
        !response ||
        !response.ok
      ) {
        console.error(
          `[${profile.pseudonym}] answer failed:`,
          response?.error
        );

        return;
      }

      answeredCount++;

      console.log(
        `[${profile.pseudonym}] answered ` +
        `round ${state.round}, ` +
        `question ${state.currentQuestionIndex + 1}: ` +
        `option ${optionIndex}`
      );
    }
  );
}


/*
|--------------------------------------------------------------------------
| Graceful shutdown
|--------------------------------------------------------------------------
*/

process.on(
  "SIGINT",
  () => {
    console.log(
      "\nStopping load test..."
    );

    for (
      const client
      of clients
    ) {
      client.socket.disconnect();
    }

    setTimeout(
      () => {
        process.exit(0);
      },
      500
    );
  }
);


/*
|--------------------------------------------------------------------------
| Startup output
|--------------------------------------------------------------------------
*/

console.log("");
console.log(
  "Love-is-Phina Load Test"
);

console.log(
  `Target: ${SERVER_URL}`
);

console.log(
  `Clients: ${CLIENT_COUNT}`
);

console.log("");