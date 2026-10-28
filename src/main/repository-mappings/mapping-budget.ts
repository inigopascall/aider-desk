/** Keeps items in order while they fit; an item that does not fit is left out whole and later, smaller items are still tried. */
export const selectMappingsWithinBudget = <T>(
  items: { file: T; tokens: number }[],
  maxTokens: number,
): { sent: T[]; overBudget: { file: T; tokens: number }[] } => {
  const sent: T[] = [];
  const overBudget: { file: T; tokens: number }[] = [];
  let used = 0;
  for (const item of items) {
    if (used + item.tokens <= maxTokens) {
      sent.push(item.file);
      used += item.tokens;
    } else {
      overBudget.push(item);
    }
  }
  return { sent, overBudget };
};
