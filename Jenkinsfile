// Unified Jenkinsfile — same file on `dev` and `main`. Keep byte-identical to
// Jenkinsfile-prod (verify with `cmp -s Jenkinsfile Jenkinsfile-prod`).
//
// A first, unconditional stage validates the Jenkins job identity: the job
// name must be under Dev-App/ or Prod-App/, or the build fails fast before
// any deploy stage runs.
// The remaining stages are gated by `when {}` expressions; the trigger event
// decides which path executes, but every gate below is additionally scoped
// to its own job family — PROD stages require the job to be under Prod-App/,
// and DEV stages require the job to be under Dev-App/. Within a job family:
//   - DEV path     : PARAMETER=='run-dev' (manual) OR GITHUB_PR_MERGED=='true'
//                    AND GITHUB_REPO_NAME==REPO_NAME (auto on dev PR merge)
//   - PROD path    : GIT_TAG matches v<MAJOR>.<MINOR>.<PATCH>(-rc.<N>)?
//                    AND GITHUB_EVENT_ACTION=='published' on this repo
//
// This service has no dev-environment credentials/env-file injection step —
// unlike blacklist-service-backend, the MCP server never holds a Label Cloud
// key of its own; each consumer sends their own (see docs/DEPLOYMENT.md).

pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '20', artifactNumToKeepStr: '20'))
    }

    parameters {
        choice(name: 'PARAMETER', choices: ['', 'run-dev', 'run-prod'], description: 'Use run-dev for manual dev rebuild, run-prod for manual prod deploy; leave empty otherwise')
        string(name: 'TAG', defaultValue: '', description: 'Manual run-prod only: the vX.Y.Z release tag to build and deploy')
    }

    environment {
        REPO_NAME = "labelcloud_mcp_server"
        SERVICE = "labelcloud-mcp"
        GIT_REPO_URL = 'git@github.com:AntiMoneyLaundryBot/labelcloud_mcp_server.git'
        DOCKER_REGISTRY = "registry.digitalocean.com/machekhinasked"
        DOCKER_REGISTRY_CREDENTIAL = "admin-do-registry"
        DOCKER_BUILDKIT = "1"
        IS_GENERIC_TRIGGER = false
        GIT_TAG = "${PARAMETER == 'run-prod' ? TAG.trim() : tag}"
        SHORT_COMMIT_HASH = ''
        GITHUB_EVENT_ACTION = "${action}"
        GITHUB_PR_MERGED = "${merged}"
        GITHUB_REPO_NAME = "${reponame}"
        GITHUB_REPO_NAME_DEV = "${reponamedev}"
        SERVER_IP_DEV_APP_1 = "94.130.51.230"
        SERVER_IP_DEV_APP_2 = "142.132.155.221"
        SERVER_IP_PROD_APP_1 = "162.55.129.53"
        SERVER_IP_PROD_APP_2 = "157.90.3.234"
    }

    triggers {
        GenericTrigger(
            genericVariables: [
                [key: 'ref', value: '$.ref'],
                [key: 'tag', value: '$.release.tag_name'],
                [key: 'action', value: '$.action'],
                [key: 'merged', value: '$.pull_request.merged'],
                [key: 'reponame', value: '$.repository.name'],
                [key: 'reponamedev', value: '$.pull_request.base.repo.name']
            ],
            causeString: 'Triggered on $tag',
            tokenCredentialId: 'labelcloud-mcp-webhook-token',
            printContributedVariables: true,
            printPostContent: true,
            silentResponse: false
        )
    }

    stages {

        stage('Validate job identity') {
            steps {
                script {
                    echo "JOB_NAME = ${env.JOB_NAME}"
                    if (!(env.JOB_NAME.startsWith('Dev-App/') ||
                          env.JOB_NAME.startsWith('Prod-App/'))) {
                        error "Unrecognised JOB_NAME '${env.JOB_NAME}' — expected Dev-App/* or Prod-App/*. Refusing to deploy."
                    }
                }
            }
        }

        // ============================================================
        // PROD path — fires only on a GitHub release publish event
        // for this repo with a vX.Y.Z(-rc.N)? tag.
        // ============================================================

        stage('Checkout PROD') {
            when {
                expression {
                    return env.JOB_NAME.startsWith('Prod-App/') &&
                           (GIT_TAG ==~ /^v\d+\.\d+\.\d+(-rc\.\d+)?$/) &&
                           (PARAMETER == 'run-prod' ||
                            (GITHUB_EVENT_ACTION == 'published' && GITHUB_REPO_NAME == REPO_NAME))
                }
            }
            steps {
                script {
                    sshagent(['ssh-amlbotserviceuser']) {
                        checkout([$class: 'GitSCM',
                            branches: [[name: "refs/tags/${GIT_TAG}"]],
                            userRemoteConfigs: [[
                                url: "${GIT_REPO_URL}",
                                credentialsId: 'ssh-amlbotserviceuser'
                            ]]
                        ])
                    }
                }
            }
        }

        stage('Build PROD') {
            when {
                expression {
                    return env.JOB_NAME.startsWith('Prod-App/') &&
                           (GIT_TAG ==~ /^v\d+\.\d+\.\d+(-rc\.\d+)?$/) &&
                           (PARAMETER == 'run-prod' ||
                            (GITHUB_EVENT_ACTION == 'published' && GITHUB_REPO_NAME == REPO_NAME))
                }
            }
            steps {
                script {
                    SHORT_COMMIT_HASH = sh(
                        script: 'git rev-parse --short HEAD',
                        returnStdout: true
                    ).trim()
                    echo "On stage: ${STAGE_NAME}"
                    sh "docker build --no-cache --network host -t ${DOCKER_REGISTRY}/${SERVICE}:${GIT_TAG} -t ${DOCKER_REGISTRY}/${SERVICE}:prod ."
                }
            }
        }

        stage('Push PROD') {
            when {
                expression {
                    return env.JOB_NAME.startsWith('Prod-App/') &&
                           (GIT_TAG ==~ /^v\d+\.\d+\.\d+(-rc\.\d+)?$/) &&
                           (PARAMETER == 'run-prod' ||
                            (GITHUB_EVENT_ACTION == 'published' && GITHUB_REPO_NAME == REPO_NAME))
                }
            }
            steps {
                script {
                    echo "Pushing PROD image tag: ${GIT_TAG}"
                    docker.withRegistry("https://${DOCKER_REGISTRY}", DOCKER_REGISTRY_CREDENTIAL) {
                        sh "docker push ${DOCKER_REGISTRY}/${SERVICE}:prod"
                        sh "docker push ${DOCKER_REGISTRY}/${SERVICE}:${GIT_TAG}"
                    }
                }
            }
        }

        stage('Restart PROD APP-1') {
            when {
                expression {
                    return env.JOB_NAME.startsWith('Prod-App/') &&
                           (GIT_TAG ==~ /^v\d+\.\d+\.\d+(-rc\.\d+)?$/) &&
                           (PARAMETER == 'run-prod' ||
                            (GITHUB_EVENT_ACTION == 'published' && GITHUB_REPO_NAME == REPO_NAME))
                }
            }
            steps {
                echo "On stage: ${STAGE_NAME}"
                echo "Server_IP = ${SERVER_IP_PROD_APP_1}"
                script {
                    sh '''
                    set -e

                    ssh -o StrictHostKeyChecking=no -i /var/lib/jenkins/.ssh/id_ed25519 root@${SERVER_IP_PROD_APP_1} "docker-compose -f /root/docker-compose/$SERVICE/docker-compose.yaml pull"
                    ssh -o StrictHostKeyChecking=no -i /var/lib/jenkins/.ssh/id_ed25519 root@${SERVER_IP_PROD_APP_1} "docker-compose -f /root/docker-compose/$SERVICE/docker-compose.yaml down"
                    ssh -o StrictHostKeyChecking=no -i /var/lib/jenkins/.ssh/id_ed25519 root@${SERVER_IP_PROD_APP_1} "docker-compose -f /root/docker-compose/$SERVICE/docker-compose.yaml up -d"

                    # Post-deploy probe: the MCP HTTP transport only answers
                    # POST /mcp, so a GET must come back exactly 405.
                    sleep 8
                    ssh -o StrictHostKeyChecking=no -i /var/lib/jenkins/.ssh/id_ed25519 root@${SERVER_IP_PROD_APP_1} "docker ps --filter name=$SERVICE --format 'table {{.Names}}\\t{{.Status}}'"

                    HTTP_CODE=$(ssh -o StrictHostKeyChecking=no -i /var/lib/jenkins/.ssh/id_ed25519 root@${SERVER_IP_PROD_APP_1} "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9180/mcp")
                    echo "Post-deploy probe: HTTP ${HTTP_CODE}"
                    if [ "$HTTP_CODE" != "405" ]; then
                        echo "Post-deploy probe FAILED: expected 405, got ${HTTP_CODE}"
                        exit 1
                    fi
                    '''
                }
            }
        }

        // ============================================================
        // DEV path — fires on dev-side PR merge (auto) or manual rebuild.
        // ============================================================

        stage('Build DEV') {
            when {
                expression {
                    return env.JOB_NAME.startsWith('Dev-App/') &&
                           (PARAMETER == 'run-dev' ||
                            (GITHUB_PR_MERGED == 'true' && GITHUB_REPO_NAME == REPO_NAME))
                }
            }
            steps {
                script {
                    SHORT_COMMIT_HASH = sh(
                        script: 'git rev-parse --short HEAD',
                        returnStdout: true
                    ).trim()
                    echo "On stage: ${STAGE_NAME}"
                    sh "docker build --no-cache --network host -t ${DOCKER_REGISTRY}/${SERVICE}:${SHORT_COMMIT_HASH} -t ${DOCKER_REGISTRY}/${SERVICE}:dev ."
                }
            }
        }

        stage('Push DEV') {
            when {
                expression {
                    return env.JOB_NAME.startsWith('Dev-App/') &&
                           (PARAMETER == 'run-dev' ||
                            (GITHUB_PR_MERGED == 'true' && GITHUB_REPO_NAME == REPO_NAME))
                }
            }
            steps {
                script {
                    echo "Pushing DEV image tag: ${SHORT_COMMIT_HASH}"
                    docker.withRegistry("https://${DOCKER_REGISTRY}", DOCKER_REGISTRY_CREDENTIAL) {
                        sh "docker push ${DOCKER_REGISTRY}/${SERVICE}:dev"
                        sh "docker push ${DOCKER_REGISTRY}/${SERVICE}:${SHORT_COMMIT_HASH}"
                    }
                }
            }
        }

        stage('Restart DEV APP-1') {
            when {
                expression {
                    return env.JOB_NAME.startsWith('Dev-App/') &&
                           (PARAMETER == 'run-dev' ||
                            (GITHUB_PR_MERGED == 'true' && GITHUB_REPO_NAME == REPO_NAME))
                }
            }
            steps {
                echo "On stage: ${STAGE_NAME}"
                echo "Server_IP = ${SERVER_IP_DEV_APP_1}"
                script {
                    sh '''
                    set -e

                    ssh -o StrictHostKeyChecking=no -i /var/lib/jenkins/.ssh/id_ed25519 root@${SERVER_IP_DEV_APP_1} "docker-compose -f /root/docker-compose/$SERVICE/docker-compose.yaml pull"
                    ssh -o StrictHostKeyChecking=no -i /var/lib/jenkins/.ssh/id_ed25519 root@${SERVER_IP_DEV_APP_1} "docker-compose -f /root/docker-compose/$SERVICE/docker-compose.yaml down"
                    ssh -o StrictHostKeyChecking=no -i /var/lib/jenkins/.ssh/id_ed25519 root@${SERVER_IP_DEV_APP_1} "docker-compose -f /root/docker-compose/$SERVICE/docker-compose.yaml up -d"

                    # Post-deploy probe: the MCP HTTP transport only answers
                    # POST /mcp, so a GET must come back exactly 405.
                    sleep 8
                    ssh -o StrictHostKeyChecking=no -i /var/lib/jenkins/.ssh/id_ed25519 root@${SERVER_IP_DEV_APP_1} "docker ps --filter name=$SERVICE --format 'table {{.Names}}\\t{{.Status}}'"

                    HTTP_CODE=$(ssh -o StrictHostKeyChecking=no -i /var/lib/jenkins/.ssh/id_ed25519 root@${SERVER_IP_DEV_APP_1} "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9180/mcp")
                    echo "Post-deploy probe: HTTP ${HTTP_CODE}"
                    if [ "$HTTP_CODE" != "405" ]; then
                        echo "Post-deploy probe FAILED: expected 405, got ${HTTP_CODE}"
                        exit 1
                    fi
                    '''
                }
            }
        }
    }
}
