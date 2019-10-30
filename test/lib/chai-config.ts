import * as chai from 'chai';
import chaiAsPromised = require('chai-as-promised');
import sinonChai = require('sinon-chai');

chai.use(chaiAsPromised as any);
chai.use(sinonChai);

export = chai;
