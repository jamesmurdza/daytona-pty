# Interactive PTY for Daytona Sandboxes

Interactive PTY launcher for [Daytona](https://daytona.io) sandboxes. Lists sandboxes in a TUI, connects via tmux, and forwards stdin/stdout.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env and set DAYTONA_API_KEY
```

## Run

```bash
npm start
```

- **↑↓** select sandbox  
- **Enter** connect (or create new sandbox)  
- **Backspace** delete (press again to confirm)  
- **Escape** cancel  
- **Ctrl+D** detach from session (when connected)

When connected to a sandbox, you must use **Ctrl+D** to close the session and return to the menu. The app sends tmux detach (prefix+d) then exits the PTY connection.

## Requirements

- Node.js 18+
- Daytona API key
