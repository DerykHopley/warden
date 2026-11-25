// pg's client side of a SCRAM-SHA-256 exchange, which it ships without types. The tests use it to check a stored
// verifier the way a login would.
declare module "pg/lib/crypto/sasl.js" {
  type Session = { clientNonce: string; response: string };
  const sasl: {
    startSession(mechanisms: string[]): Session;
    continueSession(session: Session, password: string, serverFirstMessage: string): Promise<void>;
    finalizeSession(session: Session, serverFinalMessage: string): void;
  };
  export default sasl;
}
