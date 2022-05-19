import * as Formatters from '@discordjs/builders';
import { container } from '@sapphire/framework';
import { chunk, isNullish } from '@sapphire/utilities';
import dayjs from 'dayjs';
import {
  Constants,
  MessageActionRow,
  MessageButton,
  MessageEmbed,
  MessageSelectMenu,
} from 'discord.js';
import type {
  ButtonInteraction,
  Message,
  MessageComponentInteraction,
  SelectMenuInteraction,
} from 'discord.js';
import { MessageButtonStyles, MessageComponentTypes } from 'discord.js/typings/enums';
import pupa from 'pupa';
import type { A } from 'ts-toolbelt';
import { eclass as config } from '@/config/commands/professors';
import settings from '@/config/settings';
import * as EclassManager from '@/eclasses/EclassManager';
import Subject from '@/models/subject';
import ArgumentPrompter from '@/structures/ArgumentPrompter';
import type { EclassCreationOptions, GuildMessage, PrompterText } from '@/types';
import { SchoolYear } from '@/types';
import type { SubjectDocument } from '@/types/database';
import { ConfigEntriesRoles } from '@/types/database';
import { noop } from '@/utils';

const schoolYearMenu = new MessageSelectMenu()
  .setCustomId('select-schoolyear')
  .setPlaceholder(config.messages.createClassSetup.schoolYearMenu.placeholder)
  .addOptions([{
      ...config.messages.createClassSetup.schoolYearMenu.options[0],
      value: SchoolYear.L1,
    }, {
      ...config.messages.createClassSetup.schoolYearMenu.options[1],
      value: SchoolYear.L2,
    }, {
      ...config.messages.createClassSetup.schoolYearMenu.options[2],
      value: SchoolYear.L3,
  }]);

const isRecordedMenu = new MessageSelectMenu()
  .setCustomId('select-is-recorded')
  .setPlaceholder(config.messages.createClassSetup.isRecordedMenu.placeholder)
  .addOptions([{
    ...config.messages.createClassSetup.isRecordedMenu.options[0],
    value: 'yes',
  }, {
    ...config.messages.createClassSetup.isRecordedMenu.options[1],
    value: 'no',
  }]);

const targetRoleL3 = [
  new MessageButton()
    .setCustomId('button-target-role-l3-all')
    .setStyle(MessageButtonStyles.PRIMARY)
    .setEmoji(config.messages.createClassSetup.targetRoleL3.all.emoji)
    .setLabel(config.messages.createClassSetup.targetRoleL3.all.label),
  new MessageButton()
    .setCustomId('button-target-role-l3-abroad')
    .setStyle(MessageButtonStyles.SECONDARY)
    .setEmoji(config.messages.createClassSetup.targetRoleL3.abroad.emoji)
    .setLabel(config.messages.createClassSetup.targetRoleL3.abroad.label),
  new MessageButton()
    .setCustomId('button-target-role-l3-half-campus')
    .setStyle(MessageButtonStyles.SECONDARY)
    .setEmoji(config.messages.createClassSetup.targetRoleL3.campusHalfYear.emoji)
    .setLabel(config.messages.createClassSetup.targetRoleL3.campusHalfYear.label),
  new MessageButton()
    .setCustomId('button-target-role-l3-full-campus')
    .setStyle(MessageButtonStyles.SECONDARY)
    .setEmoji(config.messages.createClassSetup.targetRoleL3.campusFullYear.emoji)
    .setLabel(config.messages.createClassSetup.targetRoleL3.campusFullYear.label),
];

const targetRoles = {
  /* eslint-disable @typescript-eslint/naming-convention */
  'button-target-role-l3-all': ConfigEntriesRoles.SchoolYearL3,
  'button-target-role-l3-abroad': ConfigEntriesRoles.SchoolYearL3Abroad,
  'button-target-role-l3-half-campus': ConfigEntriesRoles.SchoolYearL3HalfCampus,
  'button-target-role-l3-full-campus': ConfigEntriesRoles.SchoolYearL3FullCampus,
  /* eslint-enable @typescript-eslint/naming-convention */
};

const getSubjectMenus = (subjects: SubjectDocument[]): MessageSelectMenu[] => {
  const menus: MessageSelectMenu[] = [];
  for (const [i, part] of chunk(subjects, 25).entries()) {
    menus.push(
      new MessageSelectMenu()
        .setCustomId(`select-subject-${i}`)
        .setPlaceholder(config.messages.createClassSetup.subjectMenu.placeholder)
        .addOptions(
          part.map(subject => ({ label: subject.name, emoji: subject.emoji, value: subject.classCode })),
        ),
    );
  }
  return menus;
};

export default class EclassInteractiveBuilder {
  public step = 0;
  public mainBotMessage: Message;
  public botMessagePrompt: GuildMessage;
  public prompter: ArgumentPrompter;
  public aborted = false;
  public responses = {
    date: null,
    subject: null,
    topic: null,
    duration: null,
    professor: null,
    targetRole: null,
    isRecorded: null,
  } as EclassCreationOptions;

  private readonly _userResponses = new Set<GuildMessage>();
  private readonly _actionRows = [
    new MessageActionRow()
      .addComponents(
        new MessageButton()
          .setCustomId('abort')
          .setLabel(config.messages.createClassSetup.abortMenu.label)
          .setStyle(Constants.MessageButtonStyles.DANGER),
      ),
  ];

  constructor(public message: GuildMessage) {}

  private get _embed(): MessageEmbed {
    return new MessageEmbed()
      .setColor(settings.colors.default)
      .setTitle(config.messages.createClassSetup.embed.title)
      .setDescription(config.messages.createClassSetup.embed.description)
      .addField(config.messages.createClassSetup.embed.stepPreviewTitle, this._buildStepsPreview())
      .addField(
        pupa(config.messages.createClassSetup.embed.currentStepTitle, { step: this.step + 1 }),
        config.messages.createClassSetup.embed.currentStepDescription[this.step],
      );
  }

  public async start(): Promise<EclassCreationOptions | null> {
    this.mainBotMessage = await this.message.channel.send({ embeds: [this._embed], components: this._actionRows });
    this.botMessagePrompt = await this.message.channel.send(
      config.messages.createClassSetup.promptMessageMenu,
    ) as GuildMessage;

    this.prompter = new ArgumentPrompter(this.message, {
      messageArray: this._userResponses,
      baseMessage: this.botMessagePrompt,
    });

    const collector = this.mainBotMessage.createMessageComponentCollector({
      componentType: MessageComponentTypes.BUTTON,
    }).on('collect', async (interaction) => {
      if (interaction.customId === 'abort')
        await this._abort(config.messages.prompts.stoppedPrompting, interaction);
    });

    try {
      await this._askPrompts();
    } catch (err: unknown) {
      if (this.aborted)
        return;

      // FIXME: Bruh this error management is so disgusting it makes me wanna throw please refactor that ASAP
      if (err instanceof Error && (err.name.includes('INTERACTION_COLLECTOR_ERROR') || err.message === 'TIME OUT')) {
        await this._abort(config.messages.prompts.promptTimeout);
        return;
      }

      if (err instanceof Error && err.message === 'STOP') {
        await this._abort(config.messages.prompts.stoppedPrompting);
        return;
      }

      const details = err instanceof Error ? err.message
        : typeof err === 'string' ? err
        : JSON.stringify(err);

      await this._abort(pupa(config.messages.createClassSetup.errors.main, { details }));
      throw err;
    } finally {
      collector.stop();
    }

    if (this.aborted)
      return;

    await this.mainBotMessage.edit({
      embeds: [this._embed.setColor(settings.colors.green).spliceFields(1, 1)],
      components: [],
    });
    await this.botMessagePrompt.delete();
    return this.responses;
  }

  private async _askPrompts(): Promise<void> {
    // 1. Ask for the targeted schoolyear
    const schoolYearInteraction = await this._makeSelectMenuStep(schoolYearMenu);
    const schoolYear = schoolYearInteraction.values.shift() as SchoolYear;
    await this._updateStep(schoolYearInteraction);

    // 2. Ask for the subject
    const subjects = await Subject.find({ schoolYear });
    if (subjects.length === 0)
      throw new Error(config.messages.createClassSetup.errors.noSubjects);
    const subjectMenus = getSubjectMenus(subjects);
    const subjectInteraction = await this._makeSelectMenuStep(...subjectMenus);

    const selectedSubjectCode = subjectInteraction.values.shift();
    this.responses.subject = subjects.find(subject => subject.classCode === selectedSubjectCode);
    await this._updateStep(subjectInteraction);

    // 3. Ask for the topic
    this.responses.topic = await this._makeMessageStep('autoPromptText', config.messages.prompts.topic);
    await this._updateStep();

    // 4. Ask for the date
    this.responses.date = await this._makeMessageStep('autoPromptDate', config.messages.prompts.date, EclassManager.validateDate);
    await this._updateStep();

    // 5. Ask for the duration
    this.responses.duration = await this._makeMessageStep('autoPromptDuration', config.messages.prompts.duration);
    await this._updateStep();

    // 6. Ask for the professor
    this.responses.professor = await this._makeMessageStep('autoPromptMember', config.messages.prompts.professor);
    await this._updateStep();

    // 7. Ask for the target role if in L3
    if (this.responses.subject.schoolYear === SchoolYear.L3) {
      const response = await this._makeButtonStep(...targetRoleL3);
      const targetRole = targetRoles[response.customId as keyof typeof targetRoles];
      this.responses.targetRole = await container.client.configManager.get(targetRole, response.guildId);
      await response.update({ embeds: [this._embed], components: this._actionRows });
    }

    // 8. Ask whether the class will be recorded
    const isRecordedInteraction = await this._makeSelectMenuStep(isRecordedMenu);
    this.responses.isRecorded = isRecordedInteraction.values.shift() === 'yes';
  }

  private async _makeSelectMenuStep(...components: MessageSelectMenu[]): Promise<SelectMenuInteraction> {
    await this.botMessagePrompt.edit(config.messages.createClassSetup.promptMessageMenu);

    this._actionRows.push(...components.map(comp => new MessageActionRow().addComponents([comp])));
    await this.mainBotMessage.edit({ components: this._actionRows });

    const interaction = await this.mainBotMessage.awaitMessageComponent({
      componentType: MessageComponentTypes.SELECT_MENU,
      time: 2 * 60 * 1000,
      filter: int => int.user.id === this.message.author.id
        && components.some(comp => comp.customId === int.customId)
        && !this.aborted,
    });
    this._actionRows.splice(1);
    return interaction;
  }

  private async _makeButtonStep(...components: MessageButton[]): Promise<ButtonInteraction> {
    await this.botMessagePrompt.edit(config.messages.createClassSetup.promptMessageMenu);

    const rows = chunk(components, 5).map(comps => new MessageActionRow().addComponents(comps));

    this._actionRows.push(...rows);
    await this.mainBotMessage.edit({ components: this._actionRows });

    const interaction = await this.mainBotMessage.awaitMessageComponent({
      componentType: MessageComponentTypes.BUTTON,
      time: 2 * 60 * 1000,
      filter: int => int.user.id === this.message.author.id
        && components.some(comp => comp.customId === int.customId)
        && !this.aborted,
    });
    this._actionRows.splice(1);
    return interaction;
  }

  private async _makeMessageStep<
    Key extends keyof ArgumentPrompter,
    TResult extends A.Await<ReturnType<ArgumentPrompter[Key]>>,
  >(
    prompter: Key,
    prompts: PrompterText,
    validator = (_resolved: TResult): boolean => true,
  ): Promise<TResult> {
    let result: TResult;
    let previousIsFailure = false;
    do {
      result = await this.prompter[prompter](prompts, previousIsFailure) as TResult;
      if (this.aborted)
        return;

      previousIsFailure = true;
      for (const response of this._userResponses) {
        if (!response.author.bot) {
          await response.delete().catch(noop);
          this._userResponses.delete(response);
        }
      }
    } while (!validator(result));

    return result;
  }

  private async _updateStep(interaction?: MessageComponentInteraction): Promise<void> {
    this.step++;
    // eslint-disable-next-line unicorn/prefer-ternary
    if (interaction)
      await interaction.update({ embeds: [this._embed], components: this._actionRows });
    else
      await this.mainBotMessage.edit({ embeds: [this._embed], components: this._actionRows });
  }

  private async _abort(text: string, interaction?: MessageComponentInteraction): Promise<void> {
    this.aborted = true;
    await this.botMessagePrompt.edit(text);

    // eslint-disable-next-line unicorn/prefer-ternary
    if (interaction)
      await interaction.update({ embeds: [this._embed.setColor(settings.colors.orange)], components: [] });
    else
      await this.mainBotMessage.edit({ embeds: [this._embed.setColor(settings.colors.orange)], components: [] });
  }

  private _buildStepsPreview(): string {
    return pupa(config.messages.createClassSetup.stepPreview, {
      schoolYear: this.responses.subject?.schoolYear ?? this._emoteForStep(0),
      subject: this.responses.subject?.name ?? this._emoteForStep(1),
      topic: this.responses.topic ?? this._emoteForStep(2),
      date: this.responses.date && this.step === 3
        ? Formatters.time(this.responses.date, Formatters.TimestampStyles.LongDate)
        : this.responses.date
          ? Formatters.time(this.responses.date, Formatters.TimestampStyles.LongDateTime)
          : this._emoteForStep(3),
      duration: this.responses.duration
        ? dayjs.duration(this.responses.duration).humanize()
        : this._emoteForStep(4),
      professor: this.responses.professor ?? this._emoteForStep(5),
      isRecorded: isNullish(this.responses.isRecorded)
        ? this._emoteForStep(6)
        : this.responses.isRecorded
          ? 'Oui :white_check_mark:'
          : 'Non :x:',
    });
  }

  private _emoteForStep(index: number): string {
    return this.step === index ? ':gear:' : ':question:';
  }
}
