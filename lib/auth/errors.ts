export class AccessError extends Error {
  constructor(public status = 400, message = "The request could not be completed.") { super(message); }
}
export const invalidCredentials = () => new AccessError(400, "Unable to verify these details. Check them and try again.");
