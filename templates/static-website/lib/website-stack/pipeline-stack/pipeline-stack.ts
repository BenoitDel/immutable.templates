import cdk = require("@aws-cdk/cdk");
import cloudfront = require("@aws-cdk/aws-cloudfront");
import codebuild = require('@aws-cdk/aws-codebuild');
import codepipeline = require("@aws-cdk/aws-codepipeline");
import codepipelineactions = require("@aws-cdk/aws-codepipeline-actions");
import iam = require("@aws-cdk/aws-iam");
import lambda = require("@aws-cdk/aws-lambda");
import s3 = require("@aws-cdk/aws-s3");

import { ComputeType, LinuxBuildImage } from "@aws-cdk/aws-codebuild";
import { PolicyStatementEffect } from "@aws-cdk/aws-iam";

interface WebsitePipelineStackProps extends cdk.StackProps {
    stage: string;
    projectName: string;
    artifactBucket: s3.Bucket;
    contentBucket: s3.Bucket;
    githubRepositoryUsername: string;
    githubRepositoryName: string;
    githubOauthToken: cdk.SecretValue;
    contentCDN: cloudfront.CloudFrontWebDistribution;
    buildImage: string;
}

export interface WebsitePipelineStack extends cdk.Stack {
    pipeline: codepipeline.Pipeline;
    codebuildProject: codebuild.Project;
    invalidationLambda: lambda.Function;
}

export class WebsitePipelineStack extends cdk.Stack {

    constructor(scope: cdk.App, id: string, props: WebsitePipelineStackProps) {
        super(scope, id, props);

        // create build project
        this.codebuildProject = new codebuild.PipelineProject(this, "${stage}-${projectName}", {
            environment: {
                computeType: ComputeType.Small,
                buildImage: LinuxBuildImage.UBUNTU_14_04_RUBY_2_5_1
            }
        })

        // create git checkout action
        var gitCheckoutAction = new codepipelineactions.GitHubSourceAction({
            actionName: "GitHubCheckout",
            outputArtifactName: "SourceArtifact",
            owner: "ThirdParty",
            repo: props.githubRepositoryName,
            branch: props.stage == "dev" ? "dev" : "master",
            oauthToken: props.githubOauthToken,
            pollForSourceChanges: false,
            runOrder: 1
        })

        // create build action
        var buildAction = new codepipelineactions.CodeBuildBuildAction({
            actionName: "Build",
            project: this.codebuildProject,
            inputArtifact: gitCheckoutAction.outputArtifact,
            outputArtifactName: "BuildArtifact",
        });

        // create deploy action
        var deployAction = new codepipelineactions.S3DeployAction({
            actionName: "Deploy",
            inputArtifact: buildAction.outputArtifact,
            extract: true,
            bucket: props.contentBucket
        });

        // create logs policy statement for invalidation lambda
        var policyStatementForLogs = new iam.PolicyStatement(PolicyStatementEffect.Allow);
        policyStatementForLogs.addAction("logs:*")
        policyStatementForLogs.addResource("arn:aws:logs:*:*:*")

        // create cloudfront invalidation permissions statement for invalidation lambda
        var policyStatementForCloudfront = new iam.PolicyStatement(PolicyStatementEffect.Allow);
        policyStatementForCloudfront.addActions(
            "codepipeline:PutJobSuccessResult",
            "codepipeline:PutJobFailureResult",
            "cloudfront:CreateInvalidation"
        )
        policyStatementForCloudfront.addResource("*")

        // create invalidation lambda
        this.invalidationLambda = new lambda.Function(this, "invalidationLambda", {
            runtime: lambda.Runtime.NodeJS810,
            handler: 'index.handler',
            code: lambda.Code.asset("../lib/invalidation-lambda"),
            environment: {
                "DISTRIBUTION_ID": props.contentCDN.distributionId
            },
            initialPolicy: [policyStatementForLogs, policyStatementForCloudfront]
        })

        // create lambda invalidation action
        var invalidationAction = new codepipelineactions.LambdaInvokeAction({
            actionName: "CacheInvalidation",
            lambda: this.invalidationLambda,
        });

        // give to pipeline permission to invoke the invalidation lambda
        new lambda.CfnPermission(this, "codepipelinePermissionLambdaInvoke", {
            functionName: this.invalidationLambda.functionArn,
            action: "lambda:InvokeFunction",
            principal: "codepipeline.amazonaws.com"
        })

        // create the pipeline
        this.pipeline = new codepipeline.Pipeline(this, "${stage}-${projectName}", {
            artifactBucket: props.artifactBucket,
            pipelineName: "${stage}-${projectName}",
            stages: [
                {
                    name: "Source",
                    actions: [gitCheckoutAction]
                },
                {
                    name: "Build",
                    actions: [buildAction],
                },
                {
                    name: "Deploy",
                    actions: [deployAction]
                },
                {
                    name: "Invalidation",
                    actions: [invalidationAction]
                }
            ]
        });

        // create logs policy statement for codebuild
        var logsPolicyStatementForCodebuild = new iam.PolicyStatement(PolicyStatementEffect.Allow);
        logsPolicyStatementForCodebuild.addActions(
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents"
        )
        logsPolicyStatementForCodebuild.addResources(
            "arn:aws:logs:" + this.region + ":" + this.accountId + ":log-group:/aws/codebuild/" + this.codebuildProject.projectName,
            "arn:aws:logs:" + this.region + ":" + this.accountId + ":log-group:/aws/codebuild/" + this.codebuildProject.projectName + ":*"
        );

        // create s3 policy statement for codebuild
        var s3PolicyStatementForCodebuild = new iam.PolicyStatement(PolicyStatementEffect.Allow);
        s3PolicyStatementForCodebuild.addActions(
            "s3:GetObject",
            "s3:GetObjectVersion",
            "s3:PutObject"
        )
        s3PolicyStatementForCodebuild.addResources(
            props.artifactBucket.bucketArn.toString() + "/*"
        );

        // put together policy statements for codebuild service
        var policyStatementsForCodebuild = new iam.Policy(this, "${stage}-${projectName}-codebuild", {
            statements: [
                logsPolicyStatementForCodebuild,
                s3PolicyStatementForCodebuild,
            ]
        })

        // create iam role for codebuild, attach policy created and grant principal service to use it
        var codebuildRole = new iam.Role(this, "${dev}-${projectName}-codebuild-role", {
            assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com')
        })
        codebuildRole.attachInlinePolicy(policyStatementsForCodebuild)

        // create s3 artifact policy statement for codepipeline
        var s3artifactPolicyStatementForCodepipeline = new iam.PolicyStatement(PolicyStatementEffect.Allow)
        s3artifactPolicyStatementForCodepipeline.addActions(
            "s3:GetObject",
            "s3:GetObjectVersion",
            "s3:PutObject"
        )
        s3artifactPolicyStatementForCodepipeline.addResources(
            props.artifactBucket.bucketArn.toString() + "/*"
        );

        // create codebuild policy statement for codepipeline
        var codebuildPolicyStatementForCodepipeline = new iam.PolicyStatement(PolicyStatementEffect.Allow)
        codebuildPolicyStatementForCodepipeline.addActions(
            "codebuild:BatchGetBuilds",
            "codebuild:StartBuild"
        )
        codebuildPolicyStatementForCodepipeline.addResources(
            this.codebuildProject.projectArn.toString()
        );

        // create s3 content policy statement for codepipeline
        var s3contentPolicyStatementForCodepipeline = new iam.PolicyStatement(PolicyStatementEffect.Allow)
        s3contentPolicyStatementForCodepipeline.addActions(
            "s3:PutObject",
            "s3:DeleteObject"
        )
        s3contentPolicyStatementForCodepipeline.addResources(
            props.contentBucket.bucketArn.toString(),
            props.contentBucket.bucketArn.toString() + "/*"
        );

        // create lambda policy statement for codepipeline
        var lambdaPolicyStatementForCodepipeline = new iam.PolicyStatement(PolicyStatementEffect.Allow)
        lambdaPolicyStatementForCodepipeline.addActions(
            'lambda:ListFunctions',
            'lambda:InvokeFunction'
        )
        lambdaPolicyStatementForCodepipeline.addResources(
            "*"
        );

        // put together policy statements for codepipeline service
        var policyStatementsForCodepipeline = new iam.Policy(this, "${stage}-${projectName}-codepipeline", {
            statements: [
                s3artifactPolicyStatementForCodepipeline,
                codebuildPolicyStatementForCodepipeline,
                s3contentPolicyStatementForCodepipeline,
                lambdaPolicyStatementForCodepipeline
            ]
        })

        // create iam role for codepipeline, attach policy created and grand principal services to use it
        var pipelineRole = new iam.Role(this, "${dev}-${projectName}-codepipeline-role", {
            assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
        });
        pipelineRole.grant(new iam.ServicePrincipal('lambda.amazonaws.com'))
        pipelineRole.attachInlinePolicy(policyStatementsForCodepipeline)

        // github webhook
        new codepipeline.CfnWebhook(this, "githubWebhook", {
            authentication: "GITHUB_HMAC",
            authenticationConfiguration: {
                secretToken: props.githubOauthToken.toString()
            },
            registerWithThirdParty: true,
            filters: [{
                jsonPath: "$.ref",
                matchEquals: "refs/heads/{Branch}",
            }],
            targetPipeline: this.pipeline.pipelineName,
            targetAction: "GitCheckout",
            targetPipelineVersion: 1
        });

    }

}