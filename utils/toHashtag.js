const toHashtag = (str) => {
  return "#" + str.toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join("#");
};

module.exports = toHashtag; 