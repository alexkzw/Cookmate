/**
 * `wink-lemmatizer` ships no types. It's a tiny, stable API — three functions,
 * one per part of speech — so a hand-written declaration is cheaper and more
 * honest than pulling in a community @types package for it.
 */
declare module "wink-lemmatizer" {
  const lemmatize: {
    noun(word: string): string;
    verb(word: string): string;
    adjective(word: string): string;
  };
  export default lemmatize;
}
