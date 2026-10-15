export interface AuthFormState {
  error?: string;
  notice?: string;
  /** Echoed back so the email field keeps its value after a failed submit. */
  email?: string;
}

export const initialAuthFormState: AuthFormState = {};
