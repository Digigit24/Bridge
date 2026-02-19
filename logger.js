const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, 'logs');

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const LOG_FILE = path.join(logsDir, 'app.log');
const ERR_FILE = path.join(logsDir, 'error.log');

function format(level, context, message, data) {
  const ts = new Date().toISOString();
  const extra = data !== undefined ? ' ' + JSON.stringify(data) : '';
  return `${ts} [${level.padEnd(5)}] [${context}] ${message}${extra}\n`;
}

function writeFile(file, line) {
  fs.appendFile(file, line, err => {
    if (err) process.stderr.write('Logger write error: ' + err.message + '\n');
  });
}

const logger = {
  info(context, message, data) {
    const line = format('INFO', context, message, data);
    process.stdout.write(line);
    writeFile(LOG_FILE, line);
  },

  warn(context, message, data) {
    const line = format('WARN', context, message, data);
    process.stdout.write(line);
    writeFile(LOG_FILE, line);
  },

  error(context, message, data) {
    const line = format('ERROR', context, message, data);
    process.stderr.write(line);
    writeFile(LOG_FILE, line);
    writeFile(ERR_FILE, line);
  },

  // Read last N lines from app.log (sync)
  readLines(n = 300) {
    try {
      if (!fs.existsSync(LOG_FILE)) return [];
      const content = fs.readFileSync(LOG_FILE, 'utf-8');
      return content.split('\n').filter(Boolean).slice(-n);
    } catch {
      return [];
    }
  }
};

module.exports = logger;
