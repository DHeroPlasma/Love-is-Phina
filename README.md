# Hochzeitsspiel

Kleines Live-Quiz für eine Hochzeit mit Node.js, Express und Socket.IO.

## Start

```bash
npm install
```

Danach `.env.example` nach `.env` kopieren und den Admin-Schlüssel ändern:

```env
PORT=3000
ADMIN_KEY=mein-geheimer-schluessel
```

Server starten:

```bash
npm start
```

Auf dem Laptop:

```text
http://localhost:3000/admin
```

Die Gäste öffnen die Adresse, die in der Admin-Ansicht neben dem QR-Code angezeigt wird.

## Netzwerk

Laptop und Smartphones müssen sich im selben WLAN befinden.

Falls die Gäste die Seite nicht öffnen können:

- prüfen, ob das WLAN direkte Kommunikation zwischen Geräten erlaubt
- die Firewall des Laptops für Node.js bzw. Port 3000 freigeben
- sicherstellen, dass kein Gäste-WLAN mit Client-Isolation verwendet wird

## Fragen bearbeiten

`data/questions.json`:

```json
{
  "id": 1,
  "text": "Wer hat zuerst „Ich liebe dich“ gesagt?",
  "options": ["Person A", "Person B"],
  "correctOption": 0
}
```

`correctOption` ist optional.

- `0` = erste Antwort ist richtig
- `1` = zweite Antwort ist richtig
- Feld weglassen = reine Abstimmung ohne Punkte

## Ablauf

1. Gäste öffnen die URL bzw. scannen den QR-Code.
2. Sie geben echten Namen und Pseudonym ein.
3. Die Spielleitung sieht beide Namen in der Admin-Ansicht.
4. Die Spielleitung startet eine Frage.
5. Jeder Gast stimmt auf dem Smartphone ab.
6. Die Spielleitung deckt das Ergebnis auf.
7. Falls `correctOption` gesetzt ist, erhalten richtige Antworten einen Punkt.
8. Danach kann direkt die nächste Frage gestartet werden.

## Hinweis

Der Zustand liegt nur im Arbeitsspeicher. Wenn der Node-Prozess neu gestartet wird, gehen Teilnehmer, Antworten und Punkte verloren. Für einen einzelnen Hochzeitsabend ist das bewusst simpel gehalten.
