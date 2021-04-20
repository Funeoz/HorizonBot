import { model, Schema } from 'mongoose';
import type { RoleIntersectionDocument, RoleIntersectionModel } from '@/types/database';

const RoleIntersectionSchema = new Schema({
  roleId: {
    type: String,
    required: true,
  },
  guildId: {
    type: String,
    required: true,
  },
  expiration: {
    type: Number,
    required: true,
  },
});

export default model<RoleIntersectionDocument, RoleIntersectionModel>('RoleIntersection', RoleIntersectionSchema);
