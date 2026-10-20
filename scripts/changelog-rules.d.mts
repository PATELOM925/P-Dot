export interface ChangelogError {
  line: number;
  title: string;
  message: string;
}
export function findChangelogErrors(text: string): ChangelogError[];
