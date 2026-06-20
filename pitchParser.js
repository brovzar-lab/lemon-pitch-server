'use strict';

/**
 * Parse the pitch session markdown document into structured pitch objects.
 * Each pitch has: pitchNumber, title, format, platform, genre, logline, story, comps, whyNow, cleanScript
 */
function parsePitchDocument(body) {
  const pitches = [];

  // Split on pitch headers
  const pitchBlocks = body.split(/(?=## PITCH \d+ OF \d+:)/);

  for (const block of pitchBlocks) {
    const headerMatch = block.match(/^## PITCH (\d+) OF \d+:\s*(.+?)$/m);
    if (!headerMatch) continue;

    const pitchNumber = parseInt(headerMatch[1], 10);
    const fullTitle = headerMatch[2].trim();

    // Format line: **Feature Film** | Netflix LatAm
    const formatMatch = block.match(/^\*\*(.+?)\*\*\s*\|\s*(.+?)$/m);
    const format = formatMatch ? formatMatch[1].trim() : '';
    const platform = formatMatch ? formatMatch[2].trim() : '';

    // Genre
    const genreMatch = block.match(/\*\*Genre:\*\*\s*(.+?)$/m);
    const genre = genreMatch ? genreMatch[1].trim() : '';

    // THE PITCH (logline in blockquote)
    const pitchMatch = block.match(/\*\*THE PITCH:\*\*\s*\n((?:>.*\n?)+)/);
    const logline = pitchMatch
      ? pitchMatch[1].replace(/^>\s*/gm, '').trim()
      : '';

    // THE STORY
    const storyMatch = block.match(/\*\*THE STORY:\*\*\s*\n([\s\S]+?)(?=\*\*COMPS:|###\s*YOUR CALL|---|\n## PITCH)/);
    const story = storyMatch ? storyMatch[1].trim() : '';

    // COMPS
    const compsMatch = block.match(/\*\*COMPS:\*\*\s*(.+?)(?=\*\*WHY NOW:|###\s*YOUR CALL|---|\n## PITCH)/s);
    const comps = compsMatch ? compsMatch[1].trim() : '';

    // WHY NOW
    const whyNowMatch = block.match(/\*\*WHY NOW:\*\*\s*([\s\S]+?)(?=\*\*WHY LEMON:|###\s*YOUR CALL|---|\n## PITCH)/);
    const whyNow = whyNowMatch ? whyNowMatch[1].trim() : '';

    const cleanScript = buildCleanScript(fullTitle, format, logline, story, comps, whyNow);

    pitches.push({
      pitchNumber,
      title: fullTitle,
      format,
      platform,
      genre,
      logline,
      story,
      comps,
      whyNow,
      cleanScript,
    });
  }

  return pitches;
}

/**
 * Build the clean TTS script from pitch components.
 * Strips markdown, labels, brackets — keeps only spoken prose.
 * Target: 2-4 minutes of audio.
 */
function buildCleanScript(title, format, logline, story, comps, whyNow) {
  const parts = [];

  // Title announcement
  parts.push(`Pitch: ${stripMarkdown(title)}.`);
  if (format) parts.push(`Format: ${stripMarkdown(format)}.`);
  parts.push('');

  // Logline
  if (logline) {
    parts.push(stripMarkdown(logline));
    parts.push('');
  }

  // Story
  if (story) {
    parts.push(stripMarkdown(story));
    parts.push('');
  }

  // Comps (shortened for spoken)
  if (comps) {
    const cleanComps = stripMarkdown(comps).replace(/\([^)]*\)/g, '').trim();
    parts.push(`Comparable titles: ${cleanComps}`);
    parts.push('');
  }

  // Why now
  if (whyNow) {
    parts.push(stripMarkdown(whyNow));
  }

  return parts.join('\n').trim();
}

/**
 * Strip markdown formatting for clean spoken text.
 */
function stripMarkdown(text) {
  return text
    // Remove bold/italic
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    // Remove headers
    .replace(/^#{1,6}\s+/gm, '')
    // Remove blockquote markers
    .replace(/^>\s*/gm, '')
    // Remove horizontal rules
    .replace(/^---+$/gm, '')
    // Remove section labels like "THE PITCH:", "THE STORY:", "COMPS:", "WHY NOW:", "WHY LEMON:"
    .replace(/^(THE PITCH|THE STORY|THE COMPS?|WHY NOW|WHY LEMON|COMPS):\s*/gim, '')
    // Remove logline labels like [LOGLINE] or (LOGLINE)
    .replace(/\[LOGLINE\]|\(LOGLINE\)/gi, '')
    // Remove checkbox items
    .replace(/\[\s*[xX ]?\s*\]/g, '')
    // Remove markdown links but keep text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove standalone bracket content
    .replace(/\[[^\]]+\]/g, '')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { parsePitchDocument, buildCleanScript, stripMarkdown };
