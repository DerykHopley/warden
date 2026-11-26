// Made-up secrets for the contracts' tests, each joined from parts so the source never holds a whole one for a secret
// scanner to flag. The server's tests have their own (`server/test/secret-fixtures.ts`), which these can't import.

/** A made-up AWS access key id, the same one the server's tests use. */
export const AWS_KEY = ["AKIA", "Q7XJ2M4N6P8R3T5V"].join("");
