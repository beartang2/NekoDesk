const FRAMES = {
  idle: [
    [" /\\_/\\ ", "( o.o ) ", " / >🍪  "],
    [" /\\_/\\ ", "( •ᴗ• )", " / >🍪  "],
    [" /\\_/\\ ", "( -.- ) ", " / >🍪  "]
  ],
  happy: [
    [" /\\_/\\ ", "( •ᴗ• )", " / >🍪  "],
    [" /\\_/\\ ", "( •ᴗ• )", " / >✨  "]
  ],
  hungry: [
    [" /\\_/\\ ", "( •́︿•̀ )", " / >   "],
    [" /\\_/\\ ", "( •́︿•̀ )", " / >🍪?" ]
  ],
  working: [
    [" /\\_/\\ ", "( •̀ᴗ•́ )", " / >🍪  "],
    [" /\\_/\\ ", "( •̀ᴗ•́ )", "_/ >🍪  "]
  ],
  error: [
    [" /\\_/\\ ", "( >_< ) ", " / >   "],
    [" /\\_/\\ ", "( •́︿•̀ )", " / >   "]
  ]
};

export function renderPet(state, tick = 0) {
  const frames = FRAMES[state] || FRAMES.idle;
  const frame = frames[tick % frames.length];
  return frame.join("\n");
}
