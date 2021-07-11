import { Store } from '@sapphire/pieces';
import { model, Schema } from 'mongoose';
import type { TagDocument, TagModel } from '@/types/database';

const TagSchema = new Schema<TagDocument, TagModel>({
  name: {
    type: String,
    required: true,
    index: true,
    unique: true,
  },
  aliases: [{
    type: String,
    default: [],
  }],
  content: {
    type: String,
    required: true,
  },
  guildId: {
    type: String,
    required: true,
  },
});

TagSchema.post('save', async () => {
  await Store.injectedContext.client.loadTags();
});
TagSchema.post('remove', async () => {
  await Store.injectedContext.client.loadTags();
});

export default model<TagDocument, TagModel>('Tags', TagSchema);