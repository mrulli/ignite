/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

// Fire me up!

module.exports = {
    implements: 'domains-routes',
    inject: ['require(lodash)', 'require(express)', 'mongo']
};

module.exports.factory = (_, express, mongo) => {
    return new Promise((factoryResolve) => {
        const router = new express.Router();

        /**
         * Get spaces and domain models accessed for user account.
         *
         * @param req Request.
         * @param res Response.
         */
        router.post('/list', (req, res) => {
            const result = {};
            let spacesIds = [];

            mongo.spaces(req.currentUserId())
                .then((spaces) => {
                    result.spaces = spaces;
                    spacesIds = mongo.spacesIds(spaces);

                    return mongo.Cluster.find({space: {$in: spacesIds}}, '_id name').sort('name').lean().exec();
                })
                .then((clusters) => {
                    result.clusters = clusters;

                    return mongo.Cache.find({space: {$in: spacesIds}}).sort('name').lean().exec();
                })
                .then((caches) => {
                    result.caches = caches;

                    return mongo.DomainModel.find({space: {$in: spacesIds}}).sort('valueType').lean().exec();
                })
                .then((domains) => {
                    result.domains = domains;

                    res.json(result);
                })
                .catch((err) => mongo.handleError(res, err));
        });

        function _updateCacheStore(cacheStoreChanges) {
            const promises = [];

            _.forEach(cacheStoreChanges, (change) =>
                promises.push(mongo.Cache.update({_id: {$eq: change.cacheId}}, change.change, {}).exec())
            );

            return Promise.all(promises);
        }

        const _saveDomainModel = (domain, savedDomains) => {
            const caches = domain.caches;
            const cacheStoreChanges = domain.cacheStoreChanges;
            const domainId = domain._id;

            if (domainId) {
                return mongo.DomainModel.update({_id: domain._id}, domain, {upsert: true}).exec()
                    .then(() => mongo.Cache.update({_id: {$in: caches}}, {$addToSet: {domains: domainId}}, {multi: true}).exec())
                    .then(() => mongo.Cache.update({_id: {$nin: caches}}, {$pull: {domains: domainId}}, {multi: true}).exec())
                    .then(() => {
                        savedDomains.push(domain);

                        return _updateCacheStore(cacheStoreChanges);
                    });
            }

            return mongo.DomainModel.findOne({space: domain.space, valueType: domain.valueType}).exec()
                .then((found) => {
                    if (found)
                        throw new Error('Domain model with value type: "' + found.valueType + '" already exist.');

                    return (new mongo.DomainModel(domain)).save();
                })
                .then((savedDomain) => {
                    savedDomains.push(savedDomain);

                    return mongo.Cache.update({_id: {$in: caches}}, {$addToSet: {domains: savedDomain._id}}, {multi: true}).exec();
                })
                .then(() => _updateCacheStore(cacheStoreChanges));
        };

        const _save = (domains, res) => {
            if (domains && domains.length > 0) {
                const savedDomains = [];
                const generatedCaches = [];
                const promises = [];

                _.forEach(domains, (domain) => {
                    if (domain.newCache) {
                        promises.push(
                            mongo.Cache.findOne({space: domain.space, name: domain.newCache.name}).exec()
                                .then((cache) => {
                                    if (cache)
                                        return Promise.resolve(cache);

                                    // If cache not found, then create it and associate with domain model.
                                    const newCache = domain.newCache;
                                    newCache.space = domain.space;

                                    return (new mongo.Cache(newCache)).save()
                                        .then((_cache) => mongo.Cluster.update({_id: {$in: _cache.clusters}}, {$addToSet: {caches: _cache._id}}, {multi: true}).exec());
                                })
                                .then((cache) => {
                                    domain.caches = [cache._id];

                                    return _saveDomainModel(domain, savedDomains);
                                })
                        );
                    }
                    else
                        promises.push(_saveDomainModel(domain, savedDomains));
                });

                Promise.all(promises)
                    .then(() => res.send({savedDomains, generatedCaches}))
                    .catch((err) => mongo.handleError(res, err));
            }
            else
                res.status(500).send('Nothing to save!');
        };

        /**
         * Save domain model.
         */
        router.post('/save', (req, res) => {
            _save([req.body], res);
        });

        /**
         * Batch save domain models.
         */
        router.post('/save/batch', (req, res) => {
            _save(req.body, res);
        });

        /**
         * Remove domain model by ._id.
         */
        router.post('/remove', (req, res) => {
            const params = req.body;
            const domainId = params._id;

            mongo.DomainModel.findOne(params).exec()
                .then((domain) => mongo.Cache.update({_id: {$in: domain.caches}}, {$pull: {domains: domainId}}, {multi: true}).exec())
                .then(() => mongo.DomainModel.remove(params).exec())
                .then(() => res.sendStatus(200))
                .catch((err) => mongo.handleError(res, err));
        });

        /**
         * Remove all domain models.
         */
        router.post('/remove/all', (req, res) => {
            let spacesIds = [];

            mongo.spaces(req.currentUserId())
                .then((spaces) => {
                    spacesIds = mongo.spacesIds(spaces);

                    return mongo.Cache.update({space: {$in: spacesIds}}, {domains: []}, {multi: true}).exec();
                })
                .then(() => mongo.DomainModel.remove({space: {$in: spacesIds}}).exec())
                .then(() => res.sendStatus(200))
                .catch((err) => mongo.handleError(res, err));
        });

        /**
         * Remove all generated demo domain models and caches.
         */
        router.post('/remove/demo', (req, res) => {
            let spaceIds = [];
            let domainIds = [];
            let cacheIds = [];

            // TODO IGNITE-843 also remove from links: Cache -> DomainModel ; DomainModel -> Cache; Cluster -> Cache.

            mongo.spaces(req.currentUserId())
                .then((spaces) => spaceIds = mongo.spacesIds(spaces))
                .then(() => mongo.DomainModel.find({$and: [{space: {$in: spaceIds}}, {demo: true}]}).lean().exec())
                .then((domains) => domainIds = _.map(domains, (domain) => domain._id))
                .then(() => mongo.Cache.update({domains: {$in: domainIds}}, {$pull: {domains: {$in: domainIds}}}, {multi: true}).exec())
                .then(() => mongo.DomainModel.remove({_id: {$in: domainIds}}).exec())
                .then(() => mongo.Cache.find({$and: [{space: {$in: spaceIds}}, {demo: true}]}).lean().exec())
                .then((caches) => cacheIds = _.map(caches, (cache) => cache._id))
                .then(() => mongo.Cluster.update({caches: {$in: cacheIds}}, {$pull: {caches: {$in: cacheIds}}}, {multi: true}).exec())
                .then(() => mongo.DomainModel.update({caches: {$in: cacheIds}}, {$pull: {caches: {$in: cacheIds}}}, {multi: true}).exec())
                .then(() => mongo.Cache.remove({$and: [{space: {$in: spaceIds}}, {demo: true}]}).exec())
                .then(() => res.sendStatus(200))
                .catch((err) => mongo.handleError(res, err));
        });

        factoryResolve(router);
    });
};

