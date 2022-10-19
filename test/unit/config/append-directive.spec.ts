import { expect } from 'chai';
import { AppendDirective } from '~/src/config/backends/extlinux-file';

describe('APPEND directive', () => {
	const supportedConfigValues = ['isolcpus'];
	const directive = new AppendDirective(supportedConfigValues);

	it('parses valid APPEND value', () => {
		VALID_VALUES.forEach(({ input, output }) =>
			expect(directive.parse(input)).to.deep.equal(output),
		);
	});

	it('errors when parsing invalid APPEND value', () => {
		INVALID_VALUES.forEach(({ input, reason }) =>
			// @ts-expect-error
			expect(() => directive.parse(input)).to.throw(reason),
		);
	});

	it('generates new string from existing string', () => {
		expect(
			directive.generate(
				{
					isolcpus: '2',
				},
				'ro rootwait',
			),
		).to.deep.equal('ro rootwait isolcpus=2');
	});

	it('generates string from existing string (replaces values)', () => {
		expect(
			directive.generate(
				{
					isolcpus: '2,4',
				},
				'ro rootwait isolcpus=2',
			),
		).to.deep.equal('ro rootwait isolcpus=2,4');
	});

	it('generates string from nothing', () => {
		expect(
			directive.generate({
				isolcpus: '2,4',
			}),
		).to.deep.equal('isolcpus=2,4');
	});

	it('generates string from nothing', () => {
		expect(
			directive.generate({
				rootwait: '',
				ro: '',
				isolcpus: '2,4',
			}),
		).to.deep.equal('rootwait ro isolcpus=2,4');
	});

	it('errors when generating with invalid ConfigOptions', () => {
		INVALID_CONFIGS_OPTIONS.forEach(({ input, reason }) =>
			expect(() => directive.generate(input)).to.throw(reason),
		);
	});
});

const VALID_VALUES = [
	{
		input: {
			APPEND: '${cbootargs} ${resin_kernel_root} ro rootwait isolcpus=2',
		},
		output: {
			'${cbootargs}': '',
			'${resin_kernel_root}': '',
			ro: '',
			rootwait: '',
			isolcpus: '2',
		},
	},
	{
		input: {
			APPEND: '',
		},
		output: {},
	},
	{
		input: {
			APPEND: 'isolcpus=2,4',
		},
		output: { isolcpus: '2,4' },
	},
];

const INVALID_VALUES = [
	{
		input: {},
		reason:
			'Could not find APPEND directive in default extlinux.conf boot entry',
	},
	{
		input: {
			APPEND: 'isolcpus=2=4',
		},
		reason: 'Unable to parse invalid value: isolcpus=2=4',
	},
];

const INVALID_CONFIGS_OPTIONS = [
	{
		input: {
			isolcpus: '2,4=',
		},
		reason:
			'One of the values being set contains an invalid character: [ value: 2,4=, key: isolcpus ]',
	},
];
