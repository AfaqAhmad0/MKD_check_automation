/**
 * message.js — WhatsApp message body extraction utilities.
 *
 * WhatsApp protocol messages have deeply nested structures that vary by
 * message type (text, image with caption, edited message, etc.). This
 * module provides a single, authoritative function to extract the
 * human-readable text from any supported message format.
 *
 * IMPORTANT: Any time a new WhatsApp message format is encountered,
 * add its extraction path here. This is the ONLY place message body
 * extraction should happen — never duplicate this logic elsewhere.
 */

/**
 * Extract the human-readable text body from a Baileys message object.
 *
 * Handles the following WhatsApp message formats (in priority order):
 *   1. Plain conversation text
 *   2. Extended text (messages with link previews, formatting, etc.)
 *   3. Image/video/document captions
 *   4. Edited messages (protocol messages wrapping the original)
 *   5. Ephemeral (disappearing) messages wrapping any of the above
 *   6. View-once messages
 *
 * @param {object} messageObj - The `msg.message` object from Baileys
 * @returns {string} The extracted text body, or empty string if none found
 */
function extractMessageBody(messageObj) {
  if (!messageObj) return "";

  // 1. Standard text conversation
  if (messageObj.conversation) {
    return messageObj.conversation;
  }

  // 2. Extended text (link previews, rich formatting)
  if (messageObj.extendedTextMessage?.text) {
    return messageObj.extendedTextMessage.text;
  }

  // 3. Media captions (image, video, document)
  if (messageObj.imageMessage?.caption) {
    return messageObj.imageMessage.caption;
  }
  if (messageObj.videoMessage?.caption) {
    return messageObj.videoMessage.caption;
  }
  if (messageObj.documentWithCaptionMessage?.message?.documentMessage?.caption) {
    return messageObj.documentWithCaptionMessage.message.documentMessage.caption;
  }
  if (messageObj.documentMessage?.caption) {
    return messageObj.documentMessage.caption;
  }

  // 4. Edited messages — WhatsApp wraps the edited content inside protocolMessage
  const edited = messageObj.protocolMessage?.editedMessage;
  if (edited) {
    // Recursively extract from the edited message (it can be any type)
    const editedText = extractMessageBody(edited);
    if (editedText) return editedText;
  }

  // 5. Ephemeral (disappearing) messages — wrapper around regular message types
  const ephemeral = messageObj.ephemeralMessage?.message;
  if (ephemeral) {
    const ephemeralText = extractMessageBody(ephemeral);
    if (ephemeralText) return ephemeralText;
  }

  // 6. View-once messages
  const viewOnce =
    messageObj.viewOnceMessage?.message ||
    messageObj.viewOnceMessageV2?.message;
  if (viewOnce) {
    const viewOnceText = extractMessageBody(viewOnce);
    if (viewOnceText) return viewOnceText;
  }

  return "";
}

module.exports = { extractMessageBody };
