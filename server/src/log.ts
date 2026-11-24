// The one logger: a JSON object per line on stdout, which Cloud Logging reads, every line through the redactor.
import { redact } from "./redact.ts";

type Severity = "INFO" | "WARNING" | "ERROR";
type Fields = Record<string, unknown>;

export type Logger = {
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
};

export function createLogger(
  write: (line: string) => void = (line) => process.stdout.write(line),
): Logger {
  const emit = (severity: Severity, message: string, fields: Fields = {}) => {
    const entry = redact({ ...fields, severity, message, time: new Date().toISOString() });
    write(`${JSON.stringify(entry)}\n`);
  };
  return {
    info: (message, fields) => emit("INFO", message, fields),
    warn: (message, fields) => emit("WARNING", message, fields),
    error: (message, fields) => emit("ERROR", message, fields),
  };
}
