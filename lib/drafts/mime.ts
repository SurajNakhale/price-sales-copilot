import { isValidAddress } from "@/lib/affected";

/**
 * The RFC 2822 message Gmail's drafts.create takes, base64url encoded. Built by
 * hand and kept small: plain text, UTF-8, addresses validated, and nothing that
 * contains a line break is allowed near a header, so a bad dealer address or
 * subject cannot inject one. Pure.
 */

const CRLF = "\r\n";

export interface RawMessageInput {
  to: string;
  bcc: string[];
  subject: string;
  body: string;
}

function assertNoLineBreak(value: string, what: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${what} must not contain a line break.`);
}

function assertAddress(value: string, what: string): void {
  assertNoLineBreak(value, what);
  if (!isValidAddress(value)) throw new Error(`${what} is not a valid email address: ${JSON.stringify(value)}.`);
}

/** RFC 2047: a non-ASCII subject becomes an encoded word; plain ASCII is left alone. */
export function encodeSubject(subject: string): string {
  assertNoLineBreak(subject, "The subject");
  // Anything outside printable ASCII needs encoding.
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

/** Long address lists must be folded: a header line may not exceed 998 characters. */
export function foldAddresses(addresses: string[]): string {
  return addresses.join(`,${CRLF} `);
}

function base64Lines(text: string): string {
  const encoded = Buffer.from(text.replaceAll("\r\n", "\n").replaceAll("\n", CRLF), "utf8").toString("base64");
  return (encoded.match(/.{1,76}/g) ?? []).join(CRLF);
}

/** The message as text, with CRLF line ends. Exposed so tests can parse it back. */
export function buildMessageText(input: RawMessageInput): string {
  assertAddress(input.to, "The To address");
  if (input.bcc.length === 0) throw new Error("A draft needs at least one Bcc address.");
  for (const address of input.bcc) assertAddress(address, "A Bcc address");

  return [
    `To: ${input.to}`,
    `Bcc: ${foldAddresses(input.bcc)}`,
    `Subject: ${encodeSubject(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(input.body),
    "",
  ].join(CRLF);
}

/** What goes in `message.raw`. */
export function buildRawMessage(input: RawMessageInput): string {
  return Buffer.from(buildMessageText(input), "utf8").toString("base64url");
}
