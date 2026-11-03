export type Notice = {
  readonly title: string;
  readonly message: string;
  readonly priority: "default" | "high";
};

// Impure edge: a push to the owner's phone (ntfy in production).
export interface NotifierPort {
  send(notice: Notice): Promise<void>;
}
