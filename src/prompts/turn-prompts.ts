import type { FrontendMessageContent } from '../frontends/frontend-message';

const remixDirections = {
  random_style: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
  random_camera: 'Ut enim ad minim veniam, quis nostrud exercitation ullamco.',
  random_composition: 'Duis aute irure dolor in reprehenderit in voluptate velit esse.',
};

const buildContentTurnText = (item: FrontendMessageContent): string => {
  switch (item.type) {
    case 'text':
      return item.text;
    case 'reply_to_generated_image':
      return `Lorem ipsum. Source: "${item.sourceImage.prompt}".`;
    case 'image_action': {
      switch (item.action) {
        case 'animate':
          return `Lorem ipsum dolor sit amet. Source: "${item.sourceImage.prompt}".`;
        case 'customize': {
          const direction = item.changes.map(({ target, promptTags }) => `Change the ${target}. Tags: ${promptTags}`).join('. ');
          return `Lorem ipsum. ${direction}. Source: "${item.sourceImage.prompt}".`;
        }
        case 'random_a':
        case 'random_b':
        case 'random_c':
          return `${remixDirections[item.action]} Source: "${item.sourceImage.prompt}".`;
        default:
          throw new Error(`${item.action} must not enter the turn prompt`);
      }
    }
  }
};

export const buildTurnPrompt = (content: readonly FrontendMessageContent[]): string => content.map(buildContentTurnText).join('\n');
