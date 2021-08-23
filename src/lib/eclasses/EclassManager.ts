import { container } from '@sapphire/pieces';
import dayjs from 'dayjs';
import type { GuildMember } from 'discord.js';
import { MessageEmbed } from 'discord.js';
import pupa from 'pupa';
import twemoji from 'twemoji';
import { eclass as config } from '@/config/commands/professors';
import settings from '@/config/settings';
import Eclass from '@/models/eclass';
import type {
  AnnouncementSchoolYear,
  EclassCreationOptions,
  EclassEmbedOptions,
  GuildMessage,
  GuildTextBasedChannel,
} from '@/types';
import type { EclassDocument } from '@/types/database';
import { ConfigEntries, EclassStatus } from '@/types/database';
import { capitalize, massSend, noop } from '@/utils';

const EMOJI_URL_REGEX = /src="(?<url>.*)"/;

const classAnnouncement: Record<AnnouncementSchoolYear, ConfigEntries> = {
  l1: ConfigEntries.ClassAnnouncementL1,
  l2: ConfigEntries.ClassAnnouncementL2,
  l3: ConfigEntries.ClassAnnouncementL3,
  general: ConfigEntries.ClassAnnouncementGeneral,
};

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export default class EclassManager {
  public static async createClass(
    message: GuildMessage,
    {
      date, classChannel, topic, duration, professor, targetRole, isRecorded,
    }: EclassCreationOptions,
  ): Promise<void> {
    // Prepare the date
    const formattedDate = dayjs(date).format(settings.configuration.dateFormat);

    // All channels start with an emote followed by the subject's name
    const fullName = classChannel.name.split('-');
    fullName.shift();
    const subject = fullName.map(capitalize).join(' ');
    const name = pupa(settings.configuration.eclassRoleFormat, { subject, topic, formattedDate });

    if (message.guild.roles.cache.some(r => r.name === name)) {
      await message.channel.send(config.messages.alreadyExists);
      return;
    }

    // Extract the school year from the category channel (L1, L2, L3...)
    const schoolYear = classChannel.parent.name.slice(-2).toLowerCase();
    const target: AnnouncementSchoolYear = Object.keys(classAnnouncement).includes(schoolYear)
      ? schoolYear as AnnouncementSchoolYear
      : 'general';

    // Get the corresponding announcement channel
    const channel = await container.client.configManager.get(message.guild.id, classAnnouncement[target]);

    if (!channel) {
      container.logger.warn(`[e-class] A new e-class was planned but no announcement channel was found, unable to create. Setup an announcement channel with "${settings.prefix}setup class"`);
      await message.channel.send(config.messages.unconfiguredChannel);
      return;
    }

    // Create & send the announcement embed
    const embed = EclassManager.createAnnouncementEmbed({
      subject,
      topic,
      formattedDate,
      duration,
      professor,
      classChannel,
      classId: '',
      isRecorded,
    });
    const announcementMessage = await channel.send({
      content: pupa(config.messages.newClassNotification, { targetRole }),
      embeds: [embed],
    });
    // Add the reaction & cache the message
    await announcementMessage.react(settings.emojis.yes);
    container.client.eclassRolesIds.add(announcementMessage.id);

    // Create the role
    const role = await message.guild.roles.create({ name, color: settings.colors.white, mentionable: true });

    // Add the class to the database
    const classId = Eclass.generateId(topic, professor, date);
    const eclass = await Eclass.create({
      classChannel: classChannel.id,
      guild: classChannel.guild.id,
      topic,
      subject,
      date: date.getTime(),
      duration,
      professor: professor.id,
      classRole: role.id,
      targetRole: targetRole.id,
      announcementMessage: announcementMessage.id,
      announcementChannel: classAnnouncement[target],
      classId,
      isRecorded,
    });
    // Use the newly created ID in the embed
    await announcementMessage.edit({
      content: announcementMessage.content,
      embeds: [embed.setFooter(pupa(config.messages.newClassEmbed.footer, { eclass }))],
    });

    // Send confirmation message
    await message.channel.send(pupa(config.messages.successfullyCreated, { eclass }));

    container.logger.debug(`[e-class] Just created class with id ${classId}.`);
  }

  public static async startClass(eclass: EclassDocument): Promise<void> {
    // Fetch the announcement message
    const announcementChannel = await container.client.configManager
      .get(eclass.guild, eclass.announcementChannel);
    const announcementMessage = await announcementChannel.messages.fetch(eclass.announcementMessage);
    // Update its embed
    const announcementEmbed = announcementMessage.embeds[0];
    announcementEmbed.setColor(settings.colors.orange);
    announcementEmbed.fields.find(field => field.name === config.messages.newClassEmbed.date).value += ` ${config.messages.valueInProgress}`;
    await announcementMessage.edit({ embeds: [announcementEmbed] });

    // Send an embed in the corresponding text channel
    const classChannel = container.client
      .guilds.resolve(eclass.guild)
      .channels.resolve(eclass.classChannel) as GuildTextBasedChannel;
    const embed = new MessageEmbed()
      .setColor(settings.colors.primary)
      .setTitle(pupa(config.messages.startClassEmbed.title, { eclass }))
      .setAuthor(config.messages.startClassEmbed.author, announcementChannel.guild.iconURL())
      .setDescription(pupa(config.messages.startClassEmbed.description, { eclass }))
      .setFooter(pupa(config.messages.startClassEmbed.footer, { eclass }));
    await classChannel.send({
      content: pupa(config.messages.startClassNotification, { classRole: eclass.classRole }),
      embeds: [embed],
    });

    // Mark the class as In Progress
    await Eclass.findByIdAndUpdate(eclass._id, { status: EclassStatus.InProgress });

    container.logger.debug(`[e-class] Just started class with id ${eclass.classId}.`);
  }

  public static async finishClass(eclass: EclassDocument): Promise<void> {
    // Fetch the announcement message
    const announcementChannel = await container.client.configManager
      .get(eclass.guild, eclass.announcementChannel);
    const announcementMessage = await announcementChannel.messages.fetch(eclass.announcementMessage);
    // Update its embed
    const announcementEmbed = announcementMessage.embeds[0];
    const statusField = announcementEmbed.fields.find(field => field.name === config.messages.newClassEmbed.date);
    statusField.value = statusField.value.replace(config.messages.valueInProgress, config.messages.valueFinished);
    await announcementMessage.edit({ embeds: [announcementEmbed] });

    // Remove the associated role
    await container.client
      .guilds.cache.get(eclass.guild)
      .roles.cache.get(eclass.classRole)
      .delete('Class finished');

    // Mark the class as finished
    await Eclass.findByIdAndUpdate(eclass._id, { status: EclassStatus.Finished });

    container.logger.debug(`[e-class] Just ended class with id ${eclass.classId}.`);
  }

  public static async cancelClass(eclass: EclassDocument): Promise<void> {
    // Fetch the announcement message
    const announcementChannel = await container.client.configManager
      .get(eclass.guild, eclass.announcementChannel);
    const announcementMessage = await announcementChannel.messages.fetch(eclass.announcementMessage);
    // Update its embed
    const announcementEmbed = announcementMessage.embeds[0];
    announcementEmbed.setColor(settings.colors.red);
    announcementEmbed.setDescription(config.messages.valueCanceled);
    announcementEmbed.spliceFields(0, 25);
    await announcementMessage.edit({ embeds: [announcementEmbed] });
    await announcementMessage.reactions.removeAll();
    // Remove from cache
    container.client.eclassRolesIds.delete(announcementMessage.id);

    // Remove the associated role
    await container.client
      .guilds.cache.get(eclass.guild)
      .roles.cache.get(eclass.classRole)
      .delete('Class canceled');

    // Mark the class as finished
    await Eclass.findByIdAndUpdate(eclass._id, { status: EclassStatus.Canceled });

    container.logger.debug(`[e-class] Just canceled class with id ${eclass.classId}.`);
  }

  public static async setRecordLink(eclass: EclassDocument, link: string): Promise<void> {
    // Fetch the announcement message
    const announcementChannel = await container.client.configManager
      .get(eclass.guild, eclass.announcementChannel);
    const announcementMessage = await announcementChannel.messages.fetch(eclass.announcementMessage);
    // Update its embed
    const announcementEmbed = announcementMessage.embeds[0];
    announcementEmbed.fields
      .find(field => field.name === config.messages.newClassEmbed.recorded)
      .value += pupa(config.messages.newClassEmbed.recordedLink, { link });
    await announcementMessage.edit({ embeds: [announcementEmbed] });

    // Mark the class as finished
    await Eclass.findByIdAndUpdate(eclass._id, { recordLink: link });

    container.logger.debug(`[e-class] Just added record link to class with id ${eclass.classId}.`);
  }

  public static async remindClass(eclass: EclassDocument): Promise<void> {
    // Resolve the associated channel
    const guild = container.client.guilds.resolve(eclass.guild);
    const classChannel = guild.channels.resolve(eclass.classChannel) as GuildTextBasedChannel;
    // Send the notification
    await classChannel.send(
      pupa(config.messages.remindClassNotification, {
        classRole: eclass.classRole,
        duration: dayjs.duration(settings.configuration.eclassReminderTime).humanize(),
      }),
    );
    // Send the private message
    await massSend(guild, eclass.subscribers, pupa(config.messages.remindClassPrivateNotification, { eclass }));

    // Mark the reminder as sent
    await Eclass.findByIdAndUpdate(eclass._id, { reminded: true });

    container.logger.debug(`[e-class] Just reminded class with id ${eclass.classId}.`);
  }

  public static createAnnouncementEmbed({
    subject,
    topic,
    formattedDate,
    duration,
    professor,
    classChannel,
    classId,
    isRecorded,
  }: EclassEmbedOptions): MessageEmbed {
    const fullName = classChannel.name.split('-');
    const baseEmoji = fullName.shift();
    const image = EMOJI_URL_REGEX.exec(twemoji.parse(baseEmoji))?.groups?.url;

    const texts = config.messages.newClassEmbed;
    return new MessageEmbed()
      .setColor(settings.colors.green)
      .setTitle(pupa(texts.title, { subject, topic }))
      .setDescription(pupa(texts.description, { subject, classChannel }))
      .setThumbnail(image)
      .setAuthor(texts.author, classChannel.guild.iconURL())
      .addField(texts.date, formattedDate, true)
      .addField(texts.duration, dayjs.duration(duration).humanize(), true)
      .addField(texts.professor, professor.toString(), true)
      .addField(texts.recorded, texts.recordedValues[Number(isRecorded)], true)
      .setFooter(pupa(texts.footer, { classId }));
  }

  public static async subscribeMember(member: GuildMember, eclass: EclassDocument): Promise<void> {
    const givenRole = member.guild.roles.cache.get(eclass.classRole);
    if (!givenRole) {
      container.logger.warn(`[e-class] The role with id ${eclass.classRole} does not exists !`);
      return;
    }

    await Eclass.findByIdAndUpdate(eclass._id, { $push: { subscribers: member.id } });
    if (!member.roles.cache.get(givenRole.id))
      await member.roles.add(givenRole);

    member.send(pupa(config.messages.subscribed, { subject: eclass.subject, topic: eclass.topic })).catch(noop);

    container.logger.debug(`[e-class] Just subscribed membed ${member.id} (${member.displayName}#${member.user.discriminator}) class with id ${eclass.classId}.`);
  }

  public static async unsubscribeMember(member: GuildMember, eclass: EclassDocument): Promise<void> {
    const givenRole = member.guild.roles.cache.get(eclass.classRole);
    if (!givenRole) {
      container.logger.warn(`[e-class] The role with id ${eclass.classRole} does not exist.`);
      return;
    }

    await Eclass.findByIdAndUpdate(eclass._id, { $pull: { subscribers: member.id } });
    if (member.roles.cache.get(givenRole.id))
      await member.roles.remove(givenRole);

    member.send(pupa(config.messages.unsubscribed, { subject: eclass.subject, topic: eclass.topic })).catch(noop);

    container.logger.debug(`[e-class] Just unsubscribed membed ${member.id} (${member.displayName}#${member.user.discriminator}) class with id ${eclass.classId}.`);
  }
}